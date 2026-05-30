/**
 * 联邦中继信誉加分去重（纯函数）。
 */
export const RELAY_BUMP_DEDUPE_MS = 24 * 3600 * 1000

/**
 * @param {Array<{ peerNodeId: string, key: string, t: number }>} relayBumpSeen 已记录贡献
 * @param {string} peerNodeId 对端节点
 * @param {string} dedupeKey 去重键
 * @param {number} [now] 当前时间
 * @returns {boolean} 24h 内已计过分则为 true
 */
export function relayBumpIsDuplicate(relayBumpSeen, peerNodeId, dedupeKey, now = Date.now()) {
	const id = String(peerNodeId || '').trim()
	if (!id) return true
	const key = String(dedupeKey || `conn:${id}`).trim()
	return (relayBumpSeen || []).some(
		h => h.peerNodeId === id && h.key === key && now - h.t <= RELAY_BUMP_DEDUPE_MS,
	)
}
