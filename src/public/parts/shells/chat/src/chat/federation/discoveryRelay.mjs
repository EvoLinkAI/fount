/**
 * 联邦群发现 gossip：discovery_announce / discovery_query。
 */
import {
	buildDiscoveryQueryResponse,
	buildSignedDiscoveryAdvertisement,
	mergeDiscoveryAdvertisement,
} from '../discovery/index.mjs'
import { pickFederationTargetPeerIds } from '../governance/peerPool.mjs'
import { listUserGroups } from '../lib/userGroups.mjs'

import { loadFederationGroupSettings, requireDagDeps } from './deps.mjs'

/** 重导出 discovery wire 解析函数。 */
export { parseDiscoveryAnnounce, parseDiscoveryQuery, parseDiscoveryQueryResponse } from '../discovery/wire.mjs'

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} nodeId 本机 nodeId
 * @param {object} slot FederationSlot
 * @returns {Promise<void>}
 */
export async function publishDiscoveryAnnounceForGroup(username, groupId, nodeId, slot) {
	const advertisement = await buildSignedDiscoveryAdvertisement(username, groupId, nodeId)
	if (!advertisement) return
	const groupSettings = await loadFederationGroupSettings(username, groupId)
	const { nodeId: selfNodeId } = requireDagDeps()
	const targets = await pickFederationTargetPeerIds(
		username,
		groupId,
		slot.getRoster(),
		groupSettings,
		selfNodeId,
	)
	const body = { nodeId, advertisements: [advertisement] }
	if (!targets.length) slot.sendDiscoveryAnnounce(body, null)
	else for (const peerId of targets) slot.sendDiscoveryAnnounce(body, peerId)
}

/**
 * @param {string} username 用户
 * @param {string} nodeId 本机 nodeId
 * @returns {Promise<void>}
 */
export async function publishDiscoveryAnnounceAllGroups(username, nodeId) {
	const { ensureFederationRoom } = await import('./room.mjs')
	for (const groupId of await listUserGroups(username)) {
		const slot = await ensureFederationRoom(username, groupId)
		if (slot) await publishDiscoveryAnnounceForGroup(username, groupId, nodeId, slot)
	}
}

/**
 * @param {string} username 用户
 * @param {object} announce 解析后的 announce
 * @returns {Promise<void>}
 */
export async function ingestDiscoveryAnnounce(username, announce) {
	for (const advertisement of announce.advertisements)
		await mergeDiscoveryAdvertisement(username, advertisement, { fromNodeHash: announce.nodeId })
}

/**
 * @param {string} username 用户
 * @param {string} nodeId 本机 nodeId
 * @param {object} query 解析后的 discovery_query
 * @param {string} peerId 请求方 peer
 * @param {(payload: unknown, peerId: string) => void} sendResponse 发送 discovery_query_response
 * @returns {Promise<void>}
 */
export async function handleDiscoveryQuery(username, nodeId, query, peerId, sendResponse) {
	sendResponse({
		requestId: query.requestId,
		nodeId,
		advertisements: await buildDiscoveryQueryResponse(username, nodeId, query.limit),
	}, peerId)
}
