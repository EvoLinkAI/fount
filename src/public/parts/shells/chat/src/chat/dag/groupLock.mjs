/**
 * 【文件】`dag/groupLock.mjs` — 单群 DAG 写路径互斥锁。
 */
import { compositeKey } from '../../../../../../../scripts/p2p/composite_key.mjs'
import { withAsyncMutex } from '../../../../../../../scripts/p2p/utils/async_mutex.mjs'

/**
 * 在群级写锁内执行 `fn`（同用户同群 DAG 持久化路径互斥）。
 * @template T
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {() => Promise<T>} fn 写操作
 * @returns {Promise<T>} `fn` 的解析结果
 */
export async function withGroupWriteLock(username, groupId, fn) {
	return withAsyncMutex(`dag-write:${compositeKey(username, groupId)}`, fn)
}
