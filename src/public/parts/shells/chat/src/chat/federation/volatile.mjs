/**
 * 【文件】federation/volatile.mjs
 * 【职责】将群 WebSocket 上的 VOLATILE 类消息（流分片、WebRTC 信令、信誉 slash 告警）经 Trystero fed_volatile 中继到稀疏联邦邻居，并在入站时转回本群 WS。
 * 【原理】publishVolatileToFederation 由 groupWsBroadcast 在广播后调用，仅当 groupFederationOwner 存在且联邦启用；信封含 nodeId、dedupeId、payload。入站验签 stream_chunk、去重后 broadcastEvent 带 fedInbound 防回环。优先级 10 在 outbound 队列最先被丢弃。
 * 【数据结构】FED_VOLATILE_WS_TYPES；信封 { nodeId, groupId, dedupeId, payload }。
 * 【关联】stream/groupWsHub、groupWsBroadcast、signing.mjs、reputation.mjs、room.mjs、registry groupFederationOwner。
 */
import { createHash } from 'node:crypto'

import { isSubjectBlocked, loadPeers } from '../governance/peers.mjs'
import { isPlainObject } from '../lib/wireIngress.mjs'

import { loadFederationGroupSettings, requireDagDeps } from './deps.mjs'
import { groupFederationOwner } from './registry.mjs'

/** 经联邦中继的 WS VOLATILE 类型（§6.4）。 */
const FED_VOLATILE_WS_TYPES = new Set([
	'stream_chunk',
	'webrtc_signal',
	'reputation_slash_alert',
])

const FED_VOLATILE_DEDUPE_MS = 8_000
/** @type {Map<string, number>} */
const fedVolatileDedupe = new Map()

/**
 * @param {object | null | undefined} payload WS 广播体
 * @returns {boolean} 是否应经联邦 VOLATILE 中继
 */
export function isFederableVolatilePayload(payload) {
	if (payload?.fedInbound) return false
	return FED_VOLATILE_WS_TYPES.has(payload?.type)
}

/**
 * @param {string} dedupeKey 去重键
 * @returns {boolean} 首次见到为 true
 */
function takeFedVolatileDedupe(dedupeKey) {
	const now = Date.now()
	if (fedVolatileDedupe.size > 4000)
		for (const [key, expiresAt] of fedVolatileDedupe)
			if (expiresAt < now - FED_VOLATILE_DEDUPE_MS) fedVolatileDedupe.delete(key)
	if (fedVolatileDedupe.has(dedupeKey)) return false
	fedVolatileDedupe.set(dedupeKey, now)
	return true
}

/**
 * 将本机 WS VOLATILE 中继到稀疏联邦邻居。
 * @param {string} groupId 群 ID
 * @param {object} payload 与 `broadcastEvent` 相同的业务体
 * @returns {Promise<void>}
 */
export async function publishVolatileToFederation(groupId, payload) {
	if (!isFederableVolatilePayload(payload)) return
	const username = groupFederationOwner.get(groupId)
	if (!username) return

	const channelId = String(payload?.channelId || '').trim() || undefined
	const { resolveFederationSlotForAction } = await import('./room.mjs')
	const slot = await resolveFederationSlotForAction(username, groupId, {
		actionName: 'fed_volatile',
		channelId,
	})
	if (!slot?.sendFedVolatile) return

	const { nodeId } = requireDagDeps()
	const groupSettings = await loadFederationGroupSettings(username, groupId)

	const { pickFederationTargetPeerIds } = await import('../governance/peerPool.mjs')
	const targets = await pickFederationTargetPeerIds(
		username,
		groupId,
		slot.getRoster?.() || [],
		groupSettings,
		nodeId,
	)
	const dedupeId = createHash('sha256')
		.update(JSON.stringify({ type: payload.type, ...payload }))
		.digest('hex')
		.slice(0, 24)
	const envelope = { nodeId, groupId, dedupeId, payload }
	if (!targets.length) {
		slot.sendFedVolatile(envelope, null)
		return
	}
	for (const peerId of targets)
		slot.sendFedVolatile(envelope, peerId)
}

/**
 * 入站 `fed_volatile`：验重后转本群 WS。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {unknown} data 信封
 * @param {string} peerId Trystero peer
 * @param {Map<string, string>} peerToNode peer → nodeId
 * @returns {Promise<void>}
 */
export async function handleIncomingFedVolatile(username, groupId, data, peerId, peerToNode) {
	if (!isPlainObject(data) || data.groupId !== groupId || !data.nodeId || !data.dedupeId || !data.payload) return
	const envelope = data
	const { payload } = envelope
	if (!isFederableVolatilePayload(payload)) return

	const { nodeId } = requireDagDeps()
	if (envelope.nodeId === nodeId) return

	const remoteNodeId = peerToNode.get(peerId) || envelope.nodeId
	const peers = await loadPeers(username, groupId)
	if (remoteNodeId && isSubjectBlocked(peers, remoteNodeId)) return
	if (envelope.nodeId && isSubjectBlocked(peers, envelope.nodeId)) return

	const dedupeKey = `${String(envelope.nodeId || remoteNodeId)}:${String(envelope.dedupeId || '')}`
	if (!takeFedVolatileDedupe(dedupeKey)) return

	const { verifyStreamChunkVolatile } = await import('../stream/signing.mjs')
	if (!await verifyStreamChunkVolatile(payload)) return

	if (payload.type === 'reputation_slash_alert') {
		const { applyVolatileSlashAlert } = await import('../governance/reputation.mjs')
		await applyVolatileSlashAlert(username, groupId, payload).catch(() => {})
		return
	}

	const { broadcastEvent } = await import('../stream/groupWsHub.mjs')
	const { groupWsRoomKeyForReplica } = await import('../stream/groupWsRooms.mjs')
	broadcastEvent(groupWsRoomKeyForReplica(username, groupId), { ...payload, fedInbound: true })
}
