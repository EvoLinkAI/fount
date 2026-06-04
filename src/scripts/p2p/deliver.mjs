import { getNodeHash } from './node_context.mjs'
import { ensureUserRoom } from './user_room.mjs'

/**
 * 定向投递：经 User Room / 共享 scope 群房间直发，不使用 TrustGraph fanout。
 * @param {string} username replica
 * @param {string} toNodeHash 64 hex 目标节点
 * @param {string} actionName Trystero action
 * @param {unknown} payload 载荷
 * @returns {Promise<boolean>} 是否已发送
 */
export async function deliver(username, toNodeHash, actionName, payload) {
	const target = String(toNodeHash).trim().toLowerCase()
	if (!target) return false
	const { sendToNode } = await import('./trust_graph.mjs')
	return sendToNode(username, target, actionName, payload)
}

/**
 * @param {string} username replica
 * @param {string} actionName Trystero action
 * @param {unknown} payload 载荷
 * @param {string | null} [exceptPeerId] 跳过的 peer
 * @param {number} [limit=6] 最多转发 peer 数
 * @returns {Promise<number>} 发送次数
 */
export async function deliverToUserRoomPeers(username, actionName, payload, exceptPeerId = null, limit = 6) {
	const slot = await ensureUserRoom(username)
	if (!slot) return 0
	const body = { ...payload, nodeHash: getNodeHash(username) }
	let sent = 0
	const peers = slot.getRoster()
		.filter(({ peerId }) => peerId && peerId !== exceptPeerId)
	for (let i = peers.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[peers[i], peers[j]] = [peers[j], peers[i]]
	}
	for (const { peerId } of peers) 
		try {
			slot.sendToPeer(peerId, actionName, body)
			sent++
			if (sent >= limit) break
		}
		catch { /* disconnected */ }
	
	return sent
}
