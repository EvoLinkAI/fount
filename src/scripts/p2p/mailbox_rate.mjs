/**
 * Mailbox 入站 put 限速（按本机用户 + 来源节点）。
 */

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_PUTS = 20

/** @type {Map<string, { count: number, resetAt: number }>} */
const inboundByKey = new Map()

/**
 * @param {object} [limits] 可选限额
 * @returns {{ windowMs: number, maxPuts: number }} 生效限额
 */
export function resolveMailboxRateLimits(limits = {}) {
	return {
		windowMs: Math.max(1000, Number(limits.windowMs) || DEFAULT_WINDOW_MS),
		maxPuts: Math.max(1, Math.min(256, Number(limits.maxPuts) || DEFAULT_MAX_PUTS)),
	}
}

/**
 * @param {string} username 用户
 * @param {string} fromNodeHash 来源节点
 * @returns {string} 限速键
 */
export function mailboxRateKey(username, fromNodeHash) {
	return `${username}\0${String(fromNodeHash || '').trim()}`
}

/**
 * @param {string} username 用户
 * @param {string} fromNodeHash 来源节点
 * @param {object} [limits] 可选限额
 * @returns {boolean} 允许新 put 则为 true
 */
export function takeIncomingMailboxPutSlot(username, fromNodeHash, limits) {
	const { windowMs, maxPuts } = resolveMailboxRateLimits(limits)
	const key = mailboxRateKey(username, fromNodeHash)
	const now = Date.now()
	let entry = inboundByKey.get(key)
	if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + windowMs }
	if (entry.count >= maxPuts) return false
	entry.count++
	inboundByKey.set(key, entry)
	if (inboundByKey.size > 8000) 
		for (const [k, v] of inboundByKey)
			if (now > v.resetAt) inboundByKey.delete(k)
	
	return true
}
