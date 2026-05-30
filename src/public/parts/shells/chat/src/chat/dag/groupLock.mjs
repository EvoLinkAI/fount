/**
 * 【文件】`dag/groupLock.mjs` — 单群 DAG 写路径互斥锁。
 * 【职责】保证同一用户同一群的 events 追加、频道消息写入与 checkpoint 刷新串行执行。
 * 【原理】基于 Promise 链的 per-key 队列（§7 WAL）：避免并发写导致 JSONL 与快照不一致；Map 过大时裁剪最旧 500 个键。
 * 【数据结构】`tails: Map<string, Promise<void>>`，键为 `username\0groupId`。
 * 【关联】`append.mjs`、`remoteIngest.mjs`、`events/quarantine.mjs`。
 */
/** 单群写路径互斥：events → channel messages → snapshot 串行化（§7 WAL 思想）。 */

/** @type {Map<string, Promise<void>>} */
const tails = new Map()

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {string} 锁键
 */
function lockKey(username, groupId) {
	return `${username}\0${groupId}`
}

/**
 * 在群级写锁内执行 `fn`（同用户同群 DAG 持久化路径互斥）。
 * @template T
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {() => Promise<T>} fn 写操作
 * @returns {Promise<T>} `fn` 的解析结果
 */
export async function withGroupWriteLock(username, groupId, fn) {
	const key = lockKey(username, groupId)
	const prev = tails.get(key) ?? Promise.resolve()
	const run = prev.catch(() => {}).then(() => fn())
	tails.set(key, run.then(() => {}, () => {}))
	if (tails.size > 4000) {
		const drop = [...tails.keys()].slice(0, 500)
		for (const k of drop) tails.delete(k)
	}
	return run
}
