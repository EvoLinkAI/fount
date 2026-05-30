import { FEDERATION_FANOUT_TOP_K } from '../../../../../../../scripts/p2p/constants.mjs'
import { resolveFederationPoolLimits, selectPeerIdsFromPool } from '../../../../../../../scripts/p2p/peer_pool.mjs'
import { getCachedTrustGraph } from '../../../../../../../scripts/p2p/trust_graph_cache.mjs'
import { registerTrustGraphProvider } from '../../../../../../../scripts/p2p/trust_graph_registry.mjs'
import { loadFederationGroupSettings, requireDagDeps } from '../federation/deps.mjs'
import { federationPartitionRoomKey, federationRooms } from '../federation/registry.mjs'
import { isSubjectBlocked } from '../governance/blocklist.mjs'
import { loadPeers } from '../governance/peers.mjs'
import { loadReputation } from '../governance/reputation.mjs'
import { listUserGroups } from '../lib/userGroups.mjs'

/**
 * @typedef {{ nodeId: string, score: number, scopeIds: string[], scopeScores?: Record<string, number> }} TrustNode
 */

/**
 * 跨群合并信誉：按 scope 数量做加权平均并保留 scopeScores 审计。
 * @param {Map<string, TrustNode>} byNode 累积图
 * @param {string} scopeId 群 ID
 * @param {string} nodeId 节点 ID
 * @param {number} score 信誉分
 * @returns {void}
 */
function mergeTrustNode(byNode, scopeId, nodeId, score) {
	const previous = byNode.get(nodeId)
	if (previous) {
		const seenCount = previous.scopeIds.length
		previous.score = (previous.score * seenCount + score) / (seenCount + 1)
		if (!previous.scopeScores) previous.scopeScores = {}
		previous.scopeScores[scopeId] = score
		if (!previous.scopeIds.includes(scopeId)) previous.scopeIds.push(scopeId)
		return
	}
	byNode.set(nodeId, { nodeId, score, scopeIds: [scopeId], scopeScores: { [scopeId]: score } })
}

/**
 * @param {string} username 用户
 * @param {{ blockedPeers: string[] }} peers 群 peers
 * @param {string} nodeId 目标节点
 * @returns {boolean} 目标节点是否被屏蔽
 */
function isNodeBlockedForUser(username, peers, nodeId) {
	return isSubjectBlocked(peers, nodeId) || isSubjectBlocked(username, { nodeHash: nodeId })
}

/**
 * @param {string} username 用户
 * @returns {Promise<Map<string, TrustNode>>} nodeId → 节点
 */
function buildMergedGraph(username) {
	return getCachedTrustGraph(username, async () => {
		/** @type {Map<string, TrustNode>} */
		const byNode = new Map()

		for (const groupId of await listUserGroups(username)) {
			const peers = await loadPeers(username, groupId)
			const reputation = await loadReputation(username, groupId)
			for (const nodeId of [...peers.trustedPeers, ...peers.explorePeers]) {
				if (isNodeBlockedForUser(username, peers, nodeId)) continue
				mergeTrustNode(byNode, groupId, nodeId, Number(reputation.byNodeId?.[nodeId]?.score ?? 0))
			}
			const slot = federationRooms.get(federationPartitionRoomKey(username, groupId, 'sync'))
			if (!slot) continue
			for (const { remoteNodeId } of slot.getRoster()) {
				if (isNodeBlockedForUser(username, peers, remoteNodeId)) continue
				mergeTrustNode(byNode, groupId, remoteNodeId, Number(reputation.byNodeId?.[remoteNodeId]?.score ?? 0.1))
			}
		}
		return byNode
	})
}

/**
 * @param {string} username 用户
 * @param {string} targetNodeId 目标 node
 * @param {string} actionName Trystero action
 * @param {unknown} payload 载荷
 * @returns {Promise<boolean>} 是否已发送
 */
async function sendToNode(username, targetNodeId, actionName, payload) {
	const targetNode = (await buildMergedGraph(username)).get(targetNodeId)
	if (!targetNode?.scopeIds.length) return false
	const { nodeId: selfNodeId } = requireDagDeps()

	for (const groupId of targetNode.scopeIds) {
		const slot = federationRooms.get(federationPartitionRoomKey(username, groupId, 'sync'))
		if (!slot) continue
		const peerId = slot.getPeerIdByNodeId(targetNodeId)
		if (peerId) {
			slot.sendToPeer(peerId, actionName, payload)
			return true
		}
		const peers = await loadPeers(username, groupId)
		const reputation = await loadReputation(username, groupId)
		const targets = selectPeerIdsFromPool({
			roster: slot.getRoster(),
			peers,
			rep: reputation,
			limits: resolveFederationPoolLimits(await loadFederationGroupSettings(username, groupId)),
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
 * @returns {import('../../../../../../../scripts/p2p/trust_graph_registry.mjs').TrustGraphProvider} Chat 默认 TrustGraphProvider
 */
export function createChatTrustGraphProvider() {
	return {
		buildMergedGraph,
		/**
		 * @param {string} username 用户
		 * @param {number} [limit=12] 最多返回节点数
		 * @returns {Promise<TrustNode[]>} 按信誉降序
		 */
		async pickTopNodes(username, limit = 12) {
			return [...(await buildMergedGraph(username)).values()]
				.sort((a, b) => b.score - a.score)
				.slice(0, Math.max(1, limit))
		},
		sendToNode,
		/**
		 * @param {string} username 用户
		 * @param {string} actionName action 名
		 * @param {unknown} payload 载荷
		 * @param {number} [limit=8] K
		 * @returns {Promise<number>} 发送次数
		 */
		async fanoutToTopNodes(username, actionName, payload, limit = FEDERATION_FANOUT_TOP_K) {
			let sent = 0
			for (const { nodeId } of await this.pickTopNodes(username, limit))
				if (await sendToNode(username, nodeId, actionName, payload)) sent++
			return sent
		},
	}
}

/**
 * 注册 Chat 默认 TrustGraphProvider。
 * @returns {void}
 */
export function registerChatTrustGraphProvider() {
	registerTrustGraphProvider('chat', createChatTrustGraphProvider())
}
