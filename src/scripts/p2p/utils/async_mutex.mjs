/**
 * 进程内 per-key 异步互斥锁（串行化 critical section）。
 */

/** @type {Map<string, Promise<unknown>>} */
const tails = new Map()

/**
 * @param {string} key 锁键
 * @param {() => Promise<T>} fn 临界区
 * @returns {Promise<T>} `fn` 的解析结果
 * @template T
 */
export async function withAsyncMutex(key, fn) {
	const lockKey = String(key)
	const prev = tails.get(lockKey) ?? Promise.resolve()
	const run = prev.catch(() => { }).then(() => fn())
	tails.set(lockKey, run)
	try {
		return await run
	}
	finally {
		if (tails.get(lockKey) === run) tails.delete(lockKey)
	}
}

/**
 * @param {string} keyPrefix 前缀
 * @returns {(key: string, fn: () => Promise<T>) => Promise<T>} 带前缀的 mutex 函数
 * @template T
 */
export function asyncMutexForPrefix(keyPrefix) {
	return (key, fn) => withAsyncMutex(`${keyPrefix}:${key}`, fn)
}
