/**
 * 【文件】gsh/buffer.mjs
 * 【职责】§11.2 GSH 代数超前缓冲：解密时遇到未来 generation 密文则计数暂存，key_rotate/成员变更推导新 H 后 flush 重试。
 * 【原理】recordGshPendingDecrypt 递增 pendingByGroup；flushGshBufferAfterRotation 在代数推进后触发批量解密；getGshBufferStats 供诊断。避免联邦先到未来代消息导致永久失败。
 * 【数据结构】pendingByGroup: Map<username\0groupId, Map<generation, count>>。
 * 【关联】gsh/content.mjs decrypt、store applyGshRotationFromEvent；scripts/p2p/gsh.mjs。
 */

/** @type {Map<string, Map<number, number>>} key → groupId, value → generation → count */
const pendingByGroup = new Map()

/**
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @returns {string} 复合键
 */
function bufKey(username, groupId) {
	return `${username}\0${groupId}`
}

/**
 * 记录一条因缺少对应 generation 的 H 而未能解密的密文。
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {number | null} generation 信封中的 key_generation
 * @returns {void}
 */
export function recordGshPendingDecrypt(username, groupId, generation) {
	if (generation == null || !Number.isFinite(generation)) return
	const k = bufKey(username, groupId)
	let m = pendingByGroup.get(k)
	if (!m) {
		m = new Map()
		pendingByGroup.set(k, m)
	}
	m.set(Math.floor(generation), (m.get(Math.floor(generation)) || 0) + 1)
}

/**
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @returns {{ total: number, byGeneration: Record<string, number> }} 待解密统计
 */
export function getGshBufferStats(username, groupId) {
	const m = pendingByGroup.get(bufKey(username, groupId))
	if (!m || !m.size) return { total: 0, byGeneration: {} }
	/** @type {Record<string, number>} */
	const byGeneration = {}
	let total = 0
	for (const [gen, n] of m) {
		byGeneration[String(gen)] = n
		total += n
	}
	return { total, byGeneration }
}

/**
 * H 轮换后清除已覆盖代数及以下的缓冲计数。
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {number} newGeneration 已写入的最新 H 代数
 * @returns {number} 清除的待解密条数
 */
export function flushGshBufferAfterRotation(username, groupId, newGeneration) {
	const k = bufKey(username, groupId)
	const m = pendingByGroup.get(k)
	if (!m || !m.size) return 0
	let cleared = 0
	for (const [gen, n] of [...m.entries()])
		if (gen <= newGeneration) {
			cleared += n
			m.delete(gen)
		}

	if (!m.size) pendingByGroup.delete(k)
	return cleared
}
