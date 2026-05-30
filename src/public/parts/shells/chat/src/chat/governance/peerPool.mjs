/**
 * 【文件】governance/peerPool.mjs
 * 【职责】联邦稀疏连接池：从 trusted/explore peers 与在线 roster 选取 gossip/DAG/volatile 中继目标，合并 PEX 节点提示并随 roster 调和池子。
 * 【原理】pickFederationTargetPeerIds 调用 scripts/p2p/peer_pool selectPeerIdsFromPool，排除本 nodeId 与拉黑节点。mergePexNodeHints 将 fed_pex hints 写入 peers 探索列表；reconcilePeerPoolFromRoster 对齐在线邻居。
 * 【数据结构】roster { peerId, remoteNodeId }[]；groupSettings 含 gossipTtl、wantIdsBudget 等联邦池参数。
 * 【关联】peers.mjs、reputation.mjs、federation index/room/gossip/volatile；scripts/p2p/peer_pool.mjs。
 */
/**
 * 【文件】governance/peerPool.mjs
 * 【职责】联邦稀疏连接池：从 roster 选目标 peer、合并 PEX 提示并提升高信誉节点为 trusted（§0 §4）。
 * 【原理】scripts/p2p/peer_pool selectPeerIdsFromPool；mergePexNodeHints 写 peers + reputation 阈值。
 * 【数据结构】roster { peerId, remoteNodeId }[]；groupSettings 限流参数。
 * 【关联】peers.mjs、reputation.mjs、federation room Trystero；resolveFederationPoolLimits。
 */
import {
	applyPexHints,
	applyRosterToPeerPool,
	resolveFederationPoolLimits,
	selectPeerIdsFromPool,
} from '../../../../../../../scripts/p2p/peer_pool.mjs'

import { loadPeers, savePeers } from './peers.mjs'
import { loadReputation } from './reputation.mjs'


/**
 * 稀疏连接池：优先 trusted，再 explore，再其余在线节点（§0、§4）。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {{ peerId: string, remoteNodeId?: string }[]} roster Trystero 在线表
 * @param {object} groupSettings 物化群设置
 * @param {string} selfNodeId 本机 node_id
 * @returns {Promise<string[]>} 目标 Trystero peerId（去重）
 */
export async function pickFederationTargetPeerIds(username, groupId, roster, groupSettings, selfNodeId) {
	const limits = resolveFederationPoolLimits(groupSettings)
	const peers = await loadPeers(username, groupId)
	const rep = await loadReputation(username, groupId)
	const inRoomNodeIds = roster
		.map(p => p.remoteNodeId)
		.map(id => String(id).trim())
		.filter(Boolean)
	return selectPeerIdsFromPool({ roster, peers, rep, limits, selfNodeId, inRoomNodeIds })
}

/**
 * 合并 PEX 提示并提升长期高信誉节点为 trusted（网络层 fed_pex，§4）。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {string[]} hints 节点 id 列表
 * @param {object} groupSettings 群设置
 * @returns {Promise<void>}
 */
export async function mergePexNodeHints(username, groupId, hints, groupSettings) {
	const limits = resolveFederationPoolLimits(groupSettings)
	const peers = await loadPeers(username, groupId)
	const rep = await loadReputation(username, groupId)
	const { trustedPeers, explorePeers } = applyPexHints({ peers, rep, hints, limits })
	await savePeers(username, groupId, { ...peers, trustedPeers, explorePeers })
}

/**
 * roster 观测：将在线节点并入 explore，并按信誉填充 trusted 槽位。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {{ remoteNodeId?: string }[]} roster 在线表
 * @param {object} groupSettings 群设置
 * @returns {Promise<void>}
 */
export async function reconcilePeerPoolFromRoster(username, groupId, roster, groupSettings) {
	if (!roster.length) return
	const limits = resolveFederationPoolLimits(groupSettings)
	const peers = await loadPeers(username, groupId)
	const rep = await loadReputation(username, groupId)
	const { trustedPeers, explorePeers } = applyRosterToPeerPool({ peers, rep, roster, limits })
	await savePeers(username, groupId, { ...peers, trustedPeers, explorePeers })
}
