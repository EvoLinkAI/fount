/**
 * 【文件】governance/peers.mjs
 * 【职责】群级 peers.json 读写：可信/探索邻居列表、拉黑 peer、最近 roster 时间，供联邦 PEX、gossip 选路与入站过滤。
 * 【原理】loadPeers/savePeers 原子写盘；addBlockedPeer 等变更 blockedPeers。isSubjectBlocked 供 room 入站 dag/gossip/chunk 与 volatile 快速拒绝。与 peerPool 分工：本文件持久化，peerPool 运行时选择。
 * 【数据结构】PeersFile { schema, trustedPeers[], explorePeers[], blockedPeers[], lastRosterAt }。
 * 【关联】peerPool.mjs、blocklist.mjs、federation room、reputation.mjs、lib/paths peersPath。
 */
/**
 * 【文件】governance/peers.mjs
 * 【职责】读写 per-group peers.json：trusted/explore/blocked 节点列表与 roster 时间戳（§7.2 §19）。
 * 【原理】normalizePeersFile 去重排序；loadPeers/savePeers 磁盘 IO；addBlockedPeer 等增量更新。
 * 【数据结构】PeersFile { schema, trustedPeers, explorePeers, blockedPeers, lastRosterAt }。
 * 【关联】peerPool、blocklist、reputation；paths peersPath；联邦 PEX/roster。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { peersPath } from '../lib/paths.mjs'

/**
 * @typedef {{
 *   schema: number
 *   trustedPeers: string[]
 *   explorePeers: string[]
 *   blockedPeers: string[]
 *   lastRosterAt: number
 * }} PeersFile
 */

/** @type {PeersFile} */
const EMPTY_PEERS = {
	schema: 1,
	trustedPeers: [],
	explorePeers: [],
	blockedPeers: [],
	lastRosterAt: 0,
}

/**
 * @param {unknown} raw 磁盘 JSON
 * @returns {PeersFile} peers 视图（§7.2 / §19）
 */
function normalizePeersFile(raw) {
	if (!raw || typeof raw !== 'object') return { ...EMPTY_PEERS }
	const file = /** @type {Record<string, unknown>} */ raw
	/**
	 * @param {string} key peers 字段名
	 * @returns {string[]} 去重后的 id 列表
	 */
	const pickIds = key => [...new Set(
		(Array.isArray(file[key]) ? file[key] : [])
			.map(id => String(id).trim())
			.filter(Boolean),
	)]
	return {
		schema: 1,
		trustedPeers: pickIds('trustedPeers'),
		explorePeers: pickIds('explorePeers'),
		blockedPeers: pickIds('blockedPeers'),
		lastRosterAt: Number.isFinite(file.lastRosterAt) ? file.lastRosterAt : 0,
	}
}

/**
 * 读取群本地 PEX / 连接池线索（不存在则空表）。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @returns {Promise<PeersFile>} 解析后的 peers 文件
 */
export async function loadPeers(username, groupId) {
	try {
		return normalizePeersFile(JSON.parse(await readFile(peersPath(username, groupId), 'utf8')))
	}
	catch {
		return { ...EMPTY_PEERS }
	}
}

/**
 * 写入 peers.json。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {PeersFile} data 数据
 * @returns {Promise<void>}
 */
export async function savePeers(username, groupId, data) {
	const path = peersPath(username, groupId)
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, JSON.stringify({ ...normalizePeersFile(data), lastRosterAt: Date.now() }, null, '\t'), 'utf8')
	const { invalidateTrustGraphCache } = await import('../../../../../../../scripts/p2p/trust_graph_cache.mjs')
	invalidateTrustGraphCache(username)
}

/**
 * 将主体加入本群 `blockedPeers`（踢人/拉黑后拒绝联邦中继，§11.0）。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {string} peerKey 节点 id 或成员 pubKeyHash
 * @returns {Promise<void>}
 */
export async function addBlockedPeer(username, groupId, peerKey) {
	const id = String(peerKey).trim()
	if (!id) return
	const peers = await loadPeers(username, groupId)
	if (!peers.blockedPeers.includes(id))
		peers.blockedPeers.push(id)
	await savePeers(username, groupId, peers)
}

/**
 * 从本群 `blockedPeers` 中移除主体（unban 后恢复联邦中继资格，§6.2）。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {string} peerKey 节点 id 或成员 pubKeyHash
 * @returns {Promise<void>}
 */
export async function removeBlockedPeer(username, groupId, peerKey) {
	const id = String(peerKey).trim()
	if (!id) return
	const peers = await loadPeers(username, groupId)
	peers.blockedPeers = peers.blockedPeers.filter(k => k !== id)
	await savePeers(username, groupId, peers)
}

/**
 * @param {PeersFile} peers peers.json 内容
 * @param {string} subject 发送方 pubKeyHash 或 remoteNodeId
 * @returns {boolean} 是否已拉黑
 */
export function isSubjectBlocked(peers, subject) {
	const key = String(subject).trim()
	return key ? peers.blockedPeers.includes(key) : false
}

/**
 * 将 ban content 中的键写入群 `blockedPeers`。
 * @param {string} username replica 登录名
 * @param {string} groupId 群 ID
 * @param {string[]} keys pubKeyHash / entityHash / nodeHash
 * @returns {Promise<void>}
 */
export async function addBlockedPeers(username, groupId, keys) {
	for (const key of keys)
		if (key) await addBlockedPeer(username, groupId, key)

}

/**
 * 将 Trystero roster 中的 `remoteNodeId` 并入 `explorePeers`（稀疏池探索集，§0、§4）。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {{ remoteNodeId?: string }[]} roster 联邦对等端列表
 * @returns {Promise<void>}
 */
export async function recordExplorePeersFromRoster(username, groupId, roster) {
	if (!roster.length) return
	const peers = await loadPeers(username, groupId)
	const exploreIds = new Set(peers.explorePeers)
	for (const peer of roster) {
		const nodeId = peer.remoteNodeId?.trim()
		if (nodeId) exploreIds.add(nodeId)
	}
	peers.explorePeers = [...exploreIds].slice(-500)
	await savePeers(username, groupId, peers)
}
