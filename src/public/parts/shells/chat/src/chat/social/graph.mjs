/**
 * 跨群合并信任图：供 Mailbox / 发现 gossip 选 Top-K 邻居。
 */
import { resolveFederationPoolLimits, selectPeerIdsFromPool } from '../../../../../../../scripts/p2p/peer_pool.mjs'
import { loadFederationGroupSettings, requireDagDeps } from '../federation/deps.mjs'
import { federationRoomKey, federationRooms } from '../federation/registry.mjs'
import { isSubjectBlocked } from '../governance/blocklist.mjs'
import { loadPeers } from '../governance/peers.mjs'
import { loadReputation } from '../governance/reputation.mjs'
import { listUserGroups } from '../lib/userGroups.mjs'

/**
 * @typedef {{ nodeId: string, score: number, groupIds: string[] }} SocialNode
 */

/**
 * @param {string} username 用户
 * @param {Map<string, SocialNode>} byNode 累积图
 * @param {string} groupId 群 ID
 * @param {string} nodeId 节点 ID
 * @param {number} score 信誉分
 * @returns {void}
 */
function mergeSocialNode(byNode, groupId, nodeId, score) {
	const previous = byNode.get(nodeId)
	if (previous) {
		previous.score = Math.max(previous.score, score)
		if (!previous.groupIds.includes(groupId)) previous.groupIds.push(groupId)
		return
	}
	byNode.set(nodeId, { nodeId, score, groupIds: [groupId] })
}

/**
 * @param {string} username 用户
 * @returns {Promise<Map<string, SocialNode>>} nodeId → 节点
 */
export async function buildMergedSocialGraph(username) {
	/** @type {Map<string, SocialNode>} */
	const byNode = new Map()

	for (const groupId of await listUserGroups(username)) {
		const peers = await loadPeers(username, groupId)
		const reputation = await loadReputation(username, groupId)
		for (const nodeId of [...peers.trustedPeers, ...peers.explorePeers]) {
			if (!nodeId || isSubjectBlocked(peers, nodeId) || isSubjectBlocked(username, { nodeHash: nodeId }))
				continue
			mergeSocialNode(byNode, groupId, nodeId, Number(reputation.byNodeId?.[nodeId]?.score ?? 0))
		}
		for (const { remoteNodeId } of federationRooms.get(federationRoomKey(username, groupId))?.getRoster?.() || []) {
			if (!remoteNodeId) continue
			if (isSubjectBlocked(peers, remoteNodeId) || isSubjectBlocked(username, { nodeHash: remoteNodeId }))
				continue
			mergeSocialNode(byNode, groupId, remoteNodeId, Number(reputation.byNodeId?.[remoteNodeId]?.score ?? 0.1))
		}
	}
	return byNode
}

/**
 * @param {string} username 用户
 * @param {number} [limit=12] 最多返回节点数
 * @returns {Promise<SocialNode[]>} 按信誉降序
 */
export async function pickTopSocialNodes(username, limit = 12) {
	return [...(await buildMergedSocialGraph(username)).values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, limit))
}

/**
 * @param {string} username 用户
 * @param {string} targetNodeId 目标 node
 * @param {string} actionName Trystero action
 * @param {unknown} payload 载荷
 * @returns {Promise<boolean>} 是否已发送
 */
export async function sendToNodeViaSocialGraph(username, targetNodeId, actionName, payload) {
	const node = (await buildMergedSocialGraph(username)).get(targetNodeId)
	if (!node?.groupIds.length) return false
	const { nodeId: selfNodeId } = requireDagDeps()

	for (const groupId of node.groupIds) {
		const slot = federationRooms.get(federationRoomKey(username, groupId))
		if (!slot?.getPeerIdByNodeId) continue
		const peerId = slot.getPeerIdByNodeId(targetNodeId)
		if (peerId) {
			slot.sendToPeer(peerId, actionName, payload)
			return true
		}
		const groupSettings = await loadFederationGroupSettings(username, groupId)
		const peers = await loadPeers(username, groupId)
		const reputation = await loadReputation(username, groupId)
		const targets = selectPeerIdsFromPool({
			roster: slot.getRoster(),
			peers,
			rep: reputation,
			limits: resolveFederationPoolLimits(groupSettings),
			selfNodeId,
		})
		if (targets.length) {
			for (const targetPeerId of targets.slice(0, 4))
				slot.sendToPeer(targetPeerId, actionName, payload)
			return true
		}
	}
	return false
}

/**
 * @param {string} username 用户
 * @param {string} actionName action 名
 * @param {unknown} payload 载荷
 * @param {number} [limit=8] K
 * @returns {Promise<number>} 发送次数
 */
export async function fanoutToTopSocialNodes(username, actionName, payload, limit = 8) {
	let sent = 0
	for (const { nodeId } of await pickTopSocialNodes(username, limit))
		if (await sendToNodeViaSocialGraph(username, nodeId, actionName, payload)) sent++
	return sent
}
