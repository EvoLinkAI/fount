/**
 * 【文件】`dag/groupLock.mjs` — 单群 DAG 写路径互斥锁。
 */
import { mapDelete, mapGet, mapSet } from '../../../../../../../scripts/p2p/composite_key.mjs'

/** @type {Map<string, Promise<void>>} */
const tails = new Map()

/**
 * 在群级写锁内执行 `fn`（同用户同群 DAG 持久化路径互斥）。
 * @template T
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {() => Promise<T>} fn 写操作
 * @returns {Promise<T>} `fn` 的解析结果
 */
export async function withGroupWriteLock(username, groupId, fn) {
	const prev = mapGet(tails, username, groupId) ?? Promise.resolve()
	const run = prev.catch(() => { }).then(() => fn())
	mapSet(tails, username, groupId, run)
	try {
		return await run
	}
	finally {
		if (mapGet(tails, username, groupId) === run) mapDelete(tails, username, groupId)
	}
}
