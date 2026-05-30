/**
 * 【文件】federation/index.mjs
 * 【职责】联邦对外门面：已签名 DAG 事件出站中继、与邻居交换 DAG 叶并触发 wantIds 补洞、gossip 拉取缺失事件，以及列出当前 Trystero 房内对等端。
 * 【原理】出站经 ensureFederationRoom 取得 Trystero MQTT 房间槽，由 peerPool 稀疏选取目标 peer（无邻居时房内广播）；入站补洞先发 fed_tip_ping/pong 收集远端 tips，再 requestMissingEventsGossip。ACL 门控事件在物化快照未就绪时入 pendingRelay 队列而非立即中继。
 * 【数据结构】signPayload 为已验签 DAG 行；catchUp 返回 tipsCollected、wantIds、eventsFilled 等统计；listFederationPeers 返回 selfNodeId、peers 名册。
 * 【关联】room.mjs、acl.mjs、pendingRelay.mjs、gossip.mjs、archiveHandshake.mjs、peerPool.mjs、deps.mjs、registry.mjs；DAG 读写在 scripts/p2p 与 dag/ 层。
 */
import { computeDagTipIdsFromEvents } from '../../../../../../../scripts/p2p/governance_branch.mjs'
import { isWantIdsInBackoff, wantIdsGroupKey } from '../../../../../../../scripts/p2p/want_ids.mjs'
import { sanitizeFederatedEvent } from '../events/wire.mjs'
import { pickFederationTargetPeerIds, reconcilePeerPoolFromRoster } from '../governance/peerPool.mjs'
import { encryptSignedEventForWire } from '../gsh/content.mjs'
import { eventsPath } from '../lib/paths.mjs'

import {
	canRelayFederatedEvent,
	canRelayFederatedEventNow,
	shouldDeferFederatedRelay,
} from './acl.mjs'
import { wireArchiveSummary, loadLocalFederationArchive } from './archiveHandshake.mjs'
import { maybeRequestBootstrapAfterCatchup } from './bootstrapRelay.mjs'
import { loadFederationGroupSettings, loadFederationMaterializedState, requireDagDeps } from './deps.mjs'
import { requestMissingEventsGossip } from './gossip.mjs'
import { isGroupFederationActive } from './groupFederation.mjs'
import { requestJoinSnapshotFromPeers } from './joinSnapshot.mjs'
import { sendPartitionBridgeFromSlot } from './partitionBridge.mjs'
import {
	LOGIC_SYNC_PARTITION,
	nodeHasPartition,
	partitionForOutboundEvent,
	pickLocalRelayPartition,
} from './partitions.mjs'
import { enqueuePendingRelay } from './pendingRelay.mjs'
import {
	EVENT_ID_HEX,
	federationRooms,
	pendingTipExchanges,
	tipExchangeKey,
} from './registry.mjs'
import { ensureFederationPartitionRoom, ensureFederationRoom } from './room.mjs'

/**
 * @param {object} signPayload 联邦签名事件
 * @returns {{ eventType: string, channelId: string }} 事件类型与频道
 */
function resolveRelayPartitionHints(signPayload) {
	const eventType = String(signPayload.type).trim().toLowerCase()
	const channelId = String(signPayload.body?.channelId).trim()
	return { eventType, channelId }
}

/**
 * 向联邦邻居请求入群快照（wire-only 请求；用于快速补齐 checkpoint/历史）。
 * @see requestJoinSnapshotFromPeers
 */
export { requestJoinSnapshotFromPeers }

/**
 * 联邦 VOLATILE 中继符号（自 volatile.mjs 再导出）。
 */
export {
	isFederableVolatilePayload,
	publishVolatileToFederation,
} from './volatile.mjs'

/**
 * @param {object} slot 联邦槽
 * @param {unknown} payload 载荷
 * @param {string[]} targets peerId 列表
 * @param {(slot: object, payload: unknown, peerId: string | null) => void} sendFn 发送函数
 * @returns {void}
 */
function deliverToFederationTargets(slot, payload, targets, sendFn) {
	if (!targets.length) {
		sendFn(slot, payload, null)
		return
	}
	for (const peerId of targets)
		sendFn(slot, payload, peerId)
}

/**
 * 将已签名事件发往稀疏池选中的邻居（无在线邻居时回退房内广播）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object} signPayload 签名事件
 * @returns {Promise<void>}
 */
export async function publishSignedEventToFederation(username, groupId, signPayload) {
	const { nodeId } = requireDagDeps()
	const materializedState = await loadFederationMaterializedState(username, groupId)
	if (!materializedState) return
	const { groupSettings } = materializedState
	const { eventType, channelId } = resolveRelayPartitionHints(signPayload)
	const targetPartition = partitionForOutboundEvent(eventType, channelId, groupSettings)
	if (!canRelayFederatedEvent(materializedState, signPayload)) return
	if (shouldDeferFederatedRelay(materializedState, signPayload)) {
		await enqueuePendingRelay(username, groupId, signPayload)
		return
	}
	if (!canRelayFederatedEventNow(materializedState, signPayload)) return

	const wireEvent = sanitizeFederatedEvent(
		await encryptSignedEventForWire(username, groupId, signPayload),
	)
	const localInTarget = nodeHasPartition(groupSettings, channelId, targetPartition)
	const outboundPartition = localInTarget
		? targetPartition
		: pickLocalRelayPartition(groupSettings, channelId)
	const slot = await ensureFederationPartitionRoom(username, groupId, outboundPartition, { channelId })
	if (!slot) return

	const targets = await pickFederationTargetPeerIds(
		username,
		groupId,
		slot.getRoster(),
		groupSettings,
		nodeId,
	)

	if (localInTarget) {
		deliverToFederationTargets(slot, wireEvent, targets, (s, payload, peerId) => s.sendDag(payload, peerId))
		return
	}

	for (const peerId of targets.length ? targets : [null])
		sendPartitionBridgeFromSlot(slot, {
			targetPartition,
			actionName: 'dag_event',
			payload: wireEvent,
			peerId,
		})

}

/**
 * 与在线邻居交换 DAG 叶 id，并对缺失叶发起 wantIds 补洞（§9）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {{ waitMs?: number, extraWantIds?: string[] }} [opts] 等待邻居 pong 毫秒数、额外索要 id
 * @returns {Promise<{ tipsCollected: number, wantIds: number, eventsFilled: number, wantIdsStillMissing: number, wantIdsRateLimited: boolean }>} 补洞统计
 */
export async function catchUpGroupFromPeers(username, groupId, opts = {}) {
	const groupSettings = await loadFederationGroupSettings(username, groupId)
	if (!isGroupFederationActive(groupSettings))
		return { tipsCollected: 0, wantIds: 0, eventsFilled: 0, wantIdsStillMissing: 0, wantIdsRateLimited: false }
	const slot = await ensureFederationPartitionRoom(username, groupId, LOGIC_SYNC_PARTITION)
	if (!slot) return { tipsCollected: 0, wantIds: 0, eventsFilled: 0, wantIdsStillMissing: 0, wantIdsRateLimited: false }

	const { nodeId, readJsonl } = requireDagDeps()
	const waitMs = Math.min(4000, Math.max(400, Number(opts.waitMs) || 1600))
	const events = await readJsonl(eventsPath(username, groupId))
	const eventsById = new Map(events.map(event => [event.id, event]))
	const localTips = computeDagTipIdsFromEvents(events)
	const localArchive = await loadLocalFederationArchive(username, groupId, readJsonl)
	const exchangeKey = tipExchangeKey(username, groupId)
	const collected = new Set()

	const remoteTips = await new Promise(resolve => {
		const timer = setTimeout(() => {
			pendingTipExchanges.delete(exchangeKey)
			resolve(collected)
		}, waitMs)
		pendingTipExchanges.set(exchangeKey, {
			collected,
			timer,
			/**
			 * 提前结束 tip 交换等待并 resolve 已收集的远端 tip id 集合。
			 * @returns {void}
			 */
			resolve: () => {
				clearTimeout(timer)
				pendingTipExchanges.delete(exchangeKey)
				resolve(collected)
			},
		})
		void (async () => {
			const targets = await pickFederationTargetPeerIds(
				username,
				groupId,
				slot.getRoster(),
				groupSettings,
				nodeId,
			)
			const ping = {
				nodeId,
				tips: localTips,
				archiveSummary: wireArchiveSummary(localArchive.summary),
			}
			if (!slot.sendTipPing) return
			if (!targets.length) slot.sendTipPing(ping, null)
			else for (const peerId of targets) slot.sendTipPing(ping, peerId)
		})().catch(error => console.error('federation: tip ping failed', error))
	})

	const wantSet = new Set()
	for (const tipId of remoteTips)
		if (!eventsById.has(tipId)) wantSet.add(tipId)
	for (const eventId of opts.extraWantIds || [])
		if (EVENT_ID_HEX.test(String(eventId)) && !eventsById.has(eventId))
			wantSet.add(String(eventId).trim().toLowerCase())

	const wantIds = [...wantSet]
	let eventsFilled = 0
	let wantIdsStillMissing = 0
	let wantIdsRateLimited = isWantIdsInBackoff(wantIdsGroupKey(username, groupId))
	if (wantIds.length) {
		const result = await requestMissingEventsGossip(username, groupId, { wantIds, awaitGossip: true })
		wantIdsStillMissing = result.stillMissing.length
		eventsFilled = wantIds.length - wantIdsStillMissing
		if (result.rateLimited) wantIdsRateLimited = true
	}
	const catchUpResult = {
		tipsCollected: remoteTips.size,
		wantIds: wantIds.length,
		eventsFilled,
		wantIdsStillMissing,
		wantIdsRateLimited,
	}
	void maybeRequestBootstrapAfterCatchup(username, groupId, catchUpResult, slot)
	return catchUpResult
}

/**
 * `GET .../peers`：本群 MQTT 房内可见对等端。
 * @param {string} username 用户名
 * @param {string} groupId 群 ID
 * @returns {Promise<{ selfNodeId: string, federationEnabled: boolean, peers: object[] }>} 本机节点与对等端列表
 */
export async function listFederationPeersForGroup(username, groupId) {
	const { nodeId } = requireDagDeps()
	const groupSettings = await loadFederationGroupSettings(username, groupId)
	if (!isGroupFederationActive(groupSettings))
		return { selfNodeId: nodeId, federationEnabled: false, peers: [] }
	const slot = await ensureFederationRoom(username, groupId)
	if (!slot)
		return { selfNodeId: nodeId, federationEnabled: false, peers: [] }
	const peersByPeerId = new Map()
	for (const peer of slot.getRoster())
		if (peer?.peerId) peersByPeerId.set(peer.peerId, peer)
	const prefix = `${username}\0${groupId}\0`
	for (const [key, roomSlot] of federationRooms)
		if (key.startsWith(prefix))
			for (const peer of roomSlot.getRoster())
				if (peer?.peerId && !peersByPeerId.has(peer.peerId))
					peersByPeerId.set(peer.peerId, peer)
	const peers = [...peersByPeerId.values()]
	void reconcilePeerPoolFromRoster(username, groupId, peers, groupSettings)
		.catch(error => console.error('peers.json pool reconcile failed', error))
	return { selfNodeId: nodeId, federationEnabled: true, peers }
}
