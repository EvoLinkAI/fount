/**
 * 【文件】federation/room.mjs
 * 【职责】按需加入 Trystero MQTT 联邦房间，注册全部 P2P action 处理器（DAG、gossip、频道历史、分块、表情、char RPC、PEX、tip 交换、fed_volatile），并暴露 FederationSlot 发送 API。
 * 【原理】joinMqttRoomWithDefaults 经 WSS relay 进入房间；普通群房间名 fount-fed-{groupId}，ECDH DM 为 dm:{sessionTag}。入站 dag_event 经 seen LRU 去重后 ingestRemoteEvent；出站经 createFedOutQueue 按优先级调度。identity_announce 建立 peerId↔nodeId；稀疏中继由 peerPool 选 peer，null 表示房内广播。
 * 【数据结构】FederationSlot：trysteroRoomName、room、sendDag、sendGossip、sendFedVolatile、sendTipPing、getRoster、getPeerIdByNodeId、sendToPeer；房内 peerToNode/nodeToPeer Map。
 * 【关联】config、registry、chunks、groupEmojiFederation、gossip、volatile、charRpc、peerPool、peers、seen、stream/groupWsHub（RPC 响应）；scripts/p2p/mqtt_room.mjs。
 */

import { computeDagTipIdsFromEvents } from '../../../../../../../scripts/p2p/governance_branch.mjs'
import { resolveFederationPoolLimits } from '../../../../../../../scripts/p2p/peer_pool.mjs'
import {
	isFederationActionAllowedUnderLoad,
	releaseRtcPeer,
	takeRtcJoinSlot,
} from '../../../../../../../scripts/p2p/rtc_connection_budget.mjs'
import { takeIncomingWantIdsSlot } from '../../../../../../../scripts/p2p/want_ids.mjs'
import { mergePexNodeHints, pickFederationTargetPeerIds } from '../governance/peerPool.mjs'
import { isSubjectBlocked, loadPeers } from '../governance/peers.mjs'
import { bumpReputationOnRelay, recordGossipAllUnknownWant } from '../governance/reputation.mjs'
import { eventsPath } from '../lib/paths.mjs'
import { extractInboundSignedEvent, isPlainObject } from '../lib/wireIngress.mjs'
import { encodeWireJson } from '../lib/wireJson.mjs'
import {
	ingestMailboxGive,
	ingestMailboxPut,
	onFederationRoomReadyForMailbox,
	parseMailboxGive,
	parseMailboxPut,
	parseMailboxWant,
	respondMailboxWant,
} from '../mailbox/delivery.mjs'

import { evaluateArchiveHandshake, loadLocalFederationArchive } from './archiveHandshake.mjs'
import {
	applyFedBootstrapResponse,
	handleFedBootstrapRequest,
	parseFedBootstrapRequest,
	parseFedBootstrapResponse,
} from './bootstrapRelay.mjs'
import { handleChannelHistoryResponse } from './channelHistory.mjs'
import {
	buildRpcErrorResponse,
	parseCharRpcRequest,
	safeSendCharRpcResponse,
} from './charRpc.mjs'
import { attachFedChunkHandlers, attachTrustGraphChunkHandlers, unregisterChunkSwarm } from './chunks.mjs'
import { getFederationSettings } from './config.mjs'
import { loadFederationGroupSettings, loadFederationMaterializedState, requireDagDeps } from './deps.mjs'
import {
	handleDiscoveryQuery,
	ingestDiscoveryAnnounce,
	parseDiscoveryAnnounce,
	parseDiscoveryQuery,
	parseDiscoveryQueryResponse,
	publishDiscoveryAnnounceForGroup,
} from './discoveryRelay.mjs'
import {
	handleGossipResponse,
	takeGossipRequestSlot,
	wantIdsLimitsFromSettings,
} from './gossip.mjs'
import { attachFedEmojiHandlers } from './groupEmojiFederation.mjs'
import { isGroupFederationActive } from './groupFederation.mjs'
import {
	applyJoinSnapshotResponse,
	handleJoinSnapshotRequest,
} from './joinSnapshot.mjs'
import { parseJoinSnapshotRequest, parseJoinSnapshotResponse } from './joinSnapshotWire.mjs'
import { resolveGroupMqttCredentials } from './mqttCredentials.mjs'
import { createFedOutQueue } from './outbound.mjs'
import {
	shouldDropPartitionBridgeUnderLoad,
	takePartitionBridgeForwardSlot,
	takePartitionBridgeSlot,
} from './partitionBridge.mjs'
import { LOGIC_SYNC_PARTITION, partitionForOutboundEvent, resolveNodePartitionIds } from './partitions.mjs'
import { resolveMemberEdPubKeyHex, validatePullAttestationForGroup } from './pullAttestation.mjs'
import { buildPullResponseEnvelope } from './pullEnvelope.mjs'
import {
	EVENT_ID_HEX,
	federationPartitionRoomKey,
	federationRoomInflight,
	federationRoomRebindGeneration,
	federationRooms,
	federationRoomKey,
	groupFederationOwner,
	pendingTipExchanges,
	tipExchangeKey,
} from './registry.mjs'
import {
	hasSeenFederationEvent,
	markSeenFederationEvent,
	warmSeenFromLocalEvents,
} from './seen.mjs'
import { handleIncomingFedVolatile } from './volatile.mjs'
import { parseChannelHistoryWant, parseFedTipPing, parseFedTipPong, parseGossipRequest } from './wireSchemas.mjs'

/**
 * @typedef {{
 *   trysteroRoomName: string,
 *   room: any,
 *   sendDag: (payload: unknown, peerId: string | null) => void,
 *   sendGossipRequest: (payload: unknown, peerId: string | null) => void,
 *   sendGossipResponse: (payload: unknown, peerId: string | null) => void,
 *   sendChannelHistoryWant: (payload: unknown, peerId: string | null) => void,
 *   sendFedVolatile: (payload: unknown, peerId: string | null) => void,
 *   getRoster: () => Array<{ peerId: string, remoteNodeId: string | undefined }>,
 *   getPeerIdByNodeId: (nodeId: string) => string | null,
 *   sendToPeer: (peerId: string, actionName: string, payload: unknown) => void,
 *   sendBootstrapRequest: (payload: unknown, peerId: string | null) => void,
 *   sendBootstrapResponse: (payload: unknown, peerId: string | null) => void,
 *   mqttPassword: string,
 *   sendDiscoveryAnnounce: (payload: unknown, peerId: string | null) => void,
 *   sendDiscoveryQuery: (payload: unknown, peerId: string | null) => void,
 *   sendDiscoveryQueryResponse: (payload: unknown, peerId: string | null) => void,
 *   sendMailboxPut: (payload: unknown, peerId: string | null) => void,
 *   sendMailboxWant: (payload: unknown, peerId: string | null) => void,
 *   sendMailboxGive: (payload: unknown, peerId: string | null) => void,
 * }} FederationSlot
 */

/**
 * 将远端 tips 并入进行中的 tip 交换收集器。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {unknown} tips 对端 tips 数组
 * @returns {void}
 */
function ingestRemoteTipsForExchange(username, groupId, tips) {
	const pending = pendingTipExchanges.get(tipExchangeKey(username, groupId))
	if (!pending || !Array.isArray(tips)) return
	for (const tipId of tips)
		if (EVENT_ID_HEX.test(String(tipId)))
			pending.collected.add(String(tipId).trim().toLowerCase())

}

/**
 * 群联邦连接缓存失效（房间名或成员变更后调用）。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @returns {void}
 */
export function invalidateFederationRoomCache(username, groupId) {
	const prefix = `${username}\0${groupId}\0`
	unregisterChunkSwarm(username, groupId)
	for (const key of [...federationRooms.keys()])
		if (key === federationRoomKey(username, groupId) || key.startsWith(prefix)) {
			federationRooms.delete(key)
			federationRoomInflight.delete(key)
			federationRoomRebindGeneration.set(key, (federationRoomRebindGeneration.get(key) || 0) + 1)
		}
	groupFederationOwner.delete(groupId)
}

/**
 * 按需加入本群所需 MQTT 分区（频道 + 逻辑慢同步）。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {{ channelId?: string }} [opts] 当前活跃频道
 * @returns {Promise<FederationSlot | null>} 主分区槽（非 sync）或唯一槽
 */
export async function ensureFederationRoom(username, groupId, opts = {}) {
	const groupSettings = await loadFederationGroupSettings(username, groupId)
	if (!isGroupFederationActive(groupSettings)) return null
	const partitionIds = resolveNodePartitionIds(groupSettings, opts.channelId)
	let primary = null
	for (const partitionId of partitionIds) {
		const slot = await ensureFederationPartitionRoom(username, groupId, partitionId, opts)
		if (partitionId !== LOGIC_SYNC_PARTITION) primary = slot || primary
		else if (!primary) primary = slot
	}
	return primary
}

/**
 * 按 action 决定联邦出站槽（频道事件优先走 ch-XX；其他走 sync）。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {{ actionName?: string, channelId?: string, eventType?: string }} [opts] 出站提示
 * @returns {Promise<FederationSlot | null>} 对应分区槽
 */
export async function resolveFederationSlotForAction(username, groupId, opts = {}) {
	const groupSettings = await loadFederationGroupSettings(username, groupId)
	if (!isGroupFederationActive(groupSettings)) return null
	const action = String(opts.actionName || '').trim().toLowerCase()
	const eventType = String(opts.eventType || '').trim().toLowerCase()
	const channelId = String(opts.channelId || '').trim() || undefined
	if (action === 'dag_event' || eventType)
		return await ensureFederationPartitionRoom(
			username,
			groupId,
			partitionForOutboundEvent(eventType || action, channelId, groupSettings),
			{ channelId },
		)
	if (action === 'fed_chunk_get' || action === 'fed_chunk_put' || action === 'fed_chunk_data')
		return await ensureFederationRoom(username, groupId, { channelId })
	return await ensureFederationPartitionRoom(username, groupId, LOGIC_SYNC_PARTITION, { channelId })
}

/**
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {string} partitionId 分区 id（空=legacy）
 * @param {{ channelId?: string }} [opts] 选项
 * @returns {Promise<FederationSlot | null>} 房间句柄或 null
 */
export async function ensureFederationPartitionRoom(username, groupId, partitionId = LOGIC_SYNC_PARTITION, opts = {}) {
	const groupSettings = await loadFederationGroupSettings(username, groupId)
	if (!isGroupFederationActive(groupSettings)) return null
	const mqttCreds = await resolveGroupMqttCredentials(username, groupId, partitionId)
	const key = federationPartitionRoomKey(username, groupId, partitionId)
	const desiredRoomName = mqttCreds.roomId
	const desiredPassword = mqttCreds.password
	if (federationRooms.has(key)) {
		const existing = federationRooms.get(key)
		if (existing?.trysteroRoomName === desiredRoomName && existing?.mqttPassword === desiredPassword)
			return existing
		federationRooms.delete(key)
		federationRoomRebindGeneration.set(key, (federationRoomRebindGeneration.get(key) || 0) + 1)
	}
	if (federationRoomInflight.has(key)) return await federationRoomInflight.get(key)

	const roomJoinTask = (async () => {
		const genAtJoin = federationRoomRebindGeneration.get(key) || 0
		const { nodeId, readJsonl, ingestRemoteEvent } = requireDagDeps()
		const trysteroRoomName = mqttCreds.roomId
		try {
			const localEvents = await readJsonl(eventsPath(username, groupId))
			warmSeenFromLocalEvents(username, groupId, localEvents)
			const data = getFederationSettings(username)
			const relayUrls = Array.isArray(data.relayUrls)
				? data.relayUrls.map(url => String(url).trim()).filter(url => url.startsWith('wss://'))
				: undefined
			const groupSettings = await loadFederationGroupSettings(username, groupId)
			const { joinMqttRoomWithDefaults } = await import('../../../../../../../scripts/p2p/mqtt_room.mjs')
			const { resolveIceServers } = await import('../../../../../../../scripts/p2p/ice_servers.mjs')
			const room = await joinMqttRoomWithDefaults({
				appId: mqttCreds.appId,
				password: mqttCreds.password,
				roomId: trysteroRoomName,
				relayUrls,
				iceServers: resolveIceServers(groupSettings),
			})
			const fedOut = createFedOutQueue()

			/** @type {Map<string, string>} peerId → nodeId */
			const peerToNode = new Map()
			/** @type {Map<string, string>} nodeId → peerId */
			const nodeToPeer = new Map()
			/** @type {Map<string, (payload: unknown, peerId: string | null) => void>} */
			const senderRegistry = new Map()

			/**
			 * @param {string} name action 名称
			 * @returns {(payload: unknown, peerId: string | null) => void} 对应 action 的发送函数
			 */
			function getActionSender(name) {
				const cached = senderRegistry.get(name)
				if (cached) return cached
				const [send] = room.makeAction(name)
				senderRegistry.set(name, send)
				return send
			}

			const [sendIdentity, getIdentity] = room.makeAction('identity_announce')
			senderRegistry.set('identity_announce', sendIdentity)
			const [sendFedPex, getFedPex] = room.makeAction('fed_pex')
			senderRegistry.set('fed_pex', sendFedPex)
			const [sendPartitionBridgeRaw, getPartitionBridge] = room.makeAction('fed_partition_bridge')
			senderRegistry.set('fed_partition_bridge', sendPartitionBridgeRaw)

			getIdentity((data, peerId) => {
				const remoteNodeId = String(data?.nodeId || '').trim()
				if (!remoteNodeId) return
				const previousNodeId = peerToNode.get(peerId)
				if (previousNodeId) nodeToPeer.delete(previousNodeId)
				peerToNode.set(peerId, remoteNodeId)
				nodeToPeer.set(remoteNodeId, peerId)
			})

			const rtcLimits = {
				maxActive: Number(groupSettings.rtcConnectionBudgetMax) || 32,
				maxJoinsPerMin: Number(groupSettings.rtcJoinRatePerMin) || 12,
			}

			room.onPeerJoin(peerId => {
				if (!takeRtcJoinSlot(key, peerId, rtcLimits)) return
				fedOut.enqueue(3, () => {
					try {
						sendIdentity({ nodeId }, peerId)
					}
					catch (error) {
						console.error('federation: identity_announce failed', error)
					}
				})
				if (!isFederationActionAllowedUnderLoad(key, 'fed_pex', rtcLimits)) return
				void (async () => {
					const stored = await loadPeers(username, groupId)
					const hints = [...stored.trustedPeers, ...stored.explorePeers].slice(0, 48)
					if (hints.length)
						fedOut.enqueue(3, () => {
							if (!isFederationActionAllowedUnderLoad(key, 'fed_pex', rtcLimits)) return
							try {
								sendFedPex({ nodeId, hints }, peerId)
							}
							catch (error) {
								console.error('federation: fed_pex failed', error)
							}
						})

				})().catch(error => console.error('federation: onPeerJoin pex failed', error))
				void import('../../../../../../../scripts/p2p/trust_graph_cache.mjs').then(({ invalidateTrustGraphCache }) => {
					invalidateTrustGraphCache(username)
				}).catch(error => console.warn('federation: invalidateTrustGraphCache failed on join', error))
			})

			getFedPex((data, peerId) => {
				if (!isFederationActionAllowedUnderLoad(key, 'fed_pex', rtcLimits)) return
				void (async () => {
					const remoteNode = String(data?.nodeId || '').trim()
					const hints = Array.isArray(data?.hints) ? data.hints : []
					if (!remoteNode || remoteNode === nodeId) return
					const groupSettings = await loadFederationGroupSettings(username, groupId)
					await mergePexNodeHints(username, groupId, hints, groupSettings)
					if (hints.length)
						await bumpReputationOnRelay(username, groupId, remoteNode, `pex:${remoteNode}`)
				})().catch(error => console.error('federation: fed_pex ingest failed', error))
			})

			getPartitionBridge((data, peerId) => {
				void (async () => {
					const envelope = isPlainObject(data) ? data : null
					const actionName = String(envelope?.actionName || '').trim()
					const targetPartition = String(envelope?.targetPartition || '').trim()
					const dedupeId = String(envelope?.dedupeId || '').trim()
					const ttl = Number(envelope?.ttl ?? 0)
					if (!actionName || !targetPartition || !dedupeId) return
					if (!Number.isFinite(ttl) || ttl <= 0) return
					if (shouldDropPartitionBridgeUnderLoad(key, actionName, rtcLimits)) return
					if (!takePartitionBridgeSlot(`${groupId}\0${targetPartition}\0${dedupeId}`)) return
					const localPartitions = resolveNodePartitionIds(groupSettings)
					if (!localPartitions.includes(targetPartition)) {
						if (ttl <= 1) return
						if (!takePartitionBridgeForwardSlot(key)) return
						const relayEnvelope = {
							...envelope,
							ttl: ttl - 1,
						}
						for (const { peerId: remotePeerId } of slot.getRoster())
							if (remotePeerId && remotePeerId !== peerId)
								slot.sendPartitionBridge(relayEnvelope, remotePeerId)
						return
					}
					const targetSlot = await ensureFederationPartitionRoom(username, groupId, targetPartition)
					if (!targetSlot) return
					try {
						if (actionName === 'dag_event' && targetSlot.sendDag)
							targetSlot.sendDag(envelope.payload, null)
						else
							targetSlot.sendToPeer(null, actionName, envelope.payload)
					}
					catch (error) {
						console.warn('federation: partition bridge dispatch failed', error)
					}
				})().catch(error => console.error('federation: partition bridge ingest failed', error))
			})

			const [sendBootstrapRequestRaw, getBootstrapRequest] = room.makeAction('fed_bootstrap_request')
			senderRegistry.set('fed_bootstrap_request', sendBootstrapRequestRaw)
			const [sendBootstrapResponseRaw, getBootstrapResponse] = room.makeAction('fed_bootstrap_response')
			senderRegistry.set('fed_bootstrap_response', sendBootstrapResponseRaw)

			/**
			 * @param {unknown} payload 响应载荷
			 * @param {string} targetPeerId 目标 peer
			 * @returns {void}
			 */
			const sendBootstrapResponse = (payload, targetPeerId) =>
				fedOut.enqueue(2, () => {
					try {
						sendBootstrapResponseRaw(payload, targetPeerId)
					}
					catch (error) {
						console.error('federation: fed_bootstrap_response failed', error)
					}
				})

			getBootstrapRequest((data, peerId) => {
				const request = parseFedBootstrapRequest(data)
				if (!request || request.groupId !== groupId) return
				void handleFedBootstrapRequest(
					username,
					groupId,
					nodeId,
					request,
					peerId,
					sendBootstrapResponse,
				).catch(error => console.error('federation: fed_bootstrap_request handler failed', error))
			})

			getBootstrapResponse(data => {
				const response = parseFedBootstrapResponse(data)
				if (!response) return
				void applyFedBootstrapResponse(username, groupId, response).catch(error =>
					console.error('federation: fed_bootstrap_response apply failed', error),
				)
			})

			const [sendJoinSnapshotRequestRaw, getJoinSnapshotRequest] = room.makeAction('fed_join_snapshot_request')
			senderRegistry.set('fed_join_snapshot_request', sendJoinSnapshotRequestRaw)
			const [sendJoinSnapshotResponseRaw, getJoinSnapshotResponse] = room.makeAction('fed_join_snapshot_response')
			senderRegistry.set('fed_join_snapshot_response', sendJoinSnapshotResponseRaw)

			getJoinSnapshotRequest((data, peerId) => {
				const request = parseJoinSnapshotRequest(data)
				if (!request) return
				void handleJoinSnapshotRequest(
					username,
					groupId,
					request,
					peerId,
					(payload, targetPeer) => {
						fedOut.enqueue(2, () => {
							try {
								sendJoinSnapshotResponseRaw(payload, targetPeer)
							}
							catch (error) {
								console.error('federation: fed_join_snapshot_response failed', error)
							}
						})
					},
				).catch(error => console.error('federation: fed_join_snapshot_request failed', error))
			})

			getJoinSnapshotResponse(data => {
				const response = parseJoinSnapshotResponse(data)
				if (!response) return
				void applyJoinSnapshotResponse(username, groupId, response).catch(error =>
					console.error('federation: fed_join_snapshot_response apply failed', error),
				)
			})

			const [sendDiscoveryAnnounceRaw, getDiscoveryAnnounce] = room.makeAction('discovery_announce')
			senderRegistry.set('discovery_announce', sendDiscoveryAnnounceRaw)
			const [sendDiscoveryQueryRaw, getDiscoveryQuery] = room.makeAction('discovery_query')
			senderRegistry.set('discovery_query', sendDiscoveryQueryRaw)
			const [sendDiscoveryQueryResponseRaw, getDiscoveryQueryResponse] = room.makeAction('discovery_query_response')
			senderRegistry.set('discovery_query_response', sendDiscoveryQueryResponseRaw)

			getDiscoveryAnnounce(data => {
				const announce = parseDiscoveryAnnounce(data)
				if (!announce) return
				void ingestDiscoveryAnnounce(username, announce).catch(error =>
					console.error('federation: discovery_announce failed', error),
				)
			})

			/**
			 * @param {unknown} payload 响应载荷
			 * @param {string} targetPeerId 目标 peer
			 * @returns {void}
			 */
			const sendDiscoveryQueryResponse = (payload, targetPeerId) =>
				fedOut.enqueue(3, () => {
					try {
						sendDiscoveryQueryResponseRaw(payload, targetPeerId)
					}
					catch (error) {
						console.error('federation: discovery_query_response failed', error)
					}
				})

			getDiscoveryQuery((data, peerId) => {
				const query = parseDiscoveryQuery(data)
				if (!query) return
				void handleDiscoveryQuery(
					username,
					nodeId,
					query,
					peerId,
					sendDiscoveryQueryResponse,
				).catch(error => console.error('federation: discovery_query failed', error))
			})

			getDiscoveryQueryResponse(data => {
				const response = parseDiscoveryQueryResponse(data)
				if (!response) return
				void ingestDiscoveryAnnounce(username, response)
					.catch(error => console.error('federation: discovery_query_response ingest failed', error))
			})

			const [sendMailboxPutRaw, getMailboxPut] = room.makeAction('mailbox_put')
			senderRegistry.set('mailbox_put', sendMailboxPutRaw)
			const [sendMailboxWantRaw, getMailboxWant] = room.makeAction('mailbox_want')
			senderRegistry.set('mailbox_want', sendMailboxWantRaw)
			const [sendMailboxGiveRaw, getMailboxGive] = room.makeAction('mailbox_give')
			senderRegistry.set('mailbox_give', sendMailboxGiveRaw)

			getMailboxPut(data => {
				if (!isFederationActionAllowedUnderLoad(key, 'mailbox_put', rtcLimits)) return
				const put = parseMailboxPut(data)
				if (!put) return
				void ingestMailboxPut(username, put).catch(error =>
					console.error('federation: mailbox_put failed', error),
				)
			})

			getMailboxWant((data, peerId) => {
				const want = parseMailboxWant(data)
				if (!want) return
				void respondMailboxWant(username, want, (payload, targetPeerId) =>
					fedOut.enqueue(4, () => {
						try {
							sendMailboxGiveRaw(payload, targetPeerId)
						}
						catch (error) {
							console.error('federation: mailbox_give failed', error)
						}
					}), peerId,
				).catch(error => console.error('federation: mailbox_want failed', error))
			})

			getMailboxGive(data => {
				const give = parseMailboxGive(data)
				if (!give) return
				void ingestMailboxGive(username, groupId, give).catch(error =>
					console.error('federation: mailbox_give ingest failed', error),
				)
			})

			attachTrustGraphChunkHandlers(username, room, fedOut, rtcLimits, key)

			const { registerSocialFederationActions } = await import('../social/federationHooks.mjs')
			registerSocialFederationActions(username, room, senderRegistry)

			room.onPeerLeave(peerId => {
				const remoteNodeId = peerToNode.get(peerId)
				if (remoteNodeId) nodeToPeer.delete(remoteNodeId)
				peerToNode.delete(peerId)
				releaseRtcPeer(key, peerId)
				void import('../../../../../../../scripts/p2p/trust_graph_cache.mjs').then(({ invalidateTrustGraphCache }) => {
					invalidateTrustGraphCache(username)
				}).catch(error => console.warn('federation: invalidateTrustGraphCache failed on leave', error))
			})

			const [sendCharRpc, getCharRpc] = room.makeAction('char_rpc')
			senderRegistry.set('char_rpc', sendCharRpc)
			const [sendCharRpcResponse, getCharRpcResponse] = room.makeAction('char_rpc_response')
			senderRegistry.set('char_rpc_response', sendCharRpcResponse)

			getCharRpc((data, peerId) => {
				const request = parseCharRpcRequest(data)
				if (!request) return
				const { requestId, memberId, method, args } = request
				/**
				 * 处理联邦 `char_rpc` 入站：本地执行 Char/World 方法并回传响应。
				 * @returns {Promise<void>}
				 */
				const handleCharRpc = async () => {
					const isWorld = String(memberId || '').includes(':world:')
					const { tryInvokeLocalCharRpc, tryInvokeLocalWorldRpc } = await import('../session.mjs')
					const result = isWorld
						? await tryInvokeLocalWorldRpc(groupId, memberId, method, args)
						: await tryInvokeLocalCharRpc(groupId, memberId, method, args)
					let response
					if (result.kind === 'result')
						response = {
							type: 'rpc_end',
							requestId,
							result: encodeWireJson(result.value, `federation.char_rpc.result:${method}`),
						}
					else if (result.kind === 'method_not_found')
						response = buildRpcErrorResponse(requestId, 'method not found', 'METHOD_NOT_FOUND')
					else if (result.kind === 'not_local')
						return
					else
						response = buildRpcErrorResponse(requestId, String(result.message || 'execution failed'), result.code)

					safeSendCharRpcResponse(sendCharRpcResponse, response, peerId)
				}
				void handleCharRpc().catch(error => {
					safeSendCharRpcResponse(
						sendCharRpcResponse,
						buildRpcErrorResponse(requestId, String(error?.message || error), error?.code),
						peerId,
					)
				})
			})

			getCharRpcResponse(data => {
				if (!isPlainObject(data)) return
				/**
				 * 处理联邦 `char_rpc_response` 入站：转交 groupWsHub 中继或消费。
				 * @returns {Promise<void>}
				 */
				const handleCharRpcResponse = async () => {
					const { relayOrConsumeRpcResponse } = await import('../stream/groupWsHub.mjs')
					relayOrConsumeRpcResponse(data)
				}
				void handleCharRpcResponse().catch(console.error)
			})

			const [sendDagRaw, getDag] = room.makeAction('dag_event')
			getDag((data, peerId) => {
				void (async () => {
					const signedEvent = extractInboundSignedEvent(data, groupId)
					if (!signedEvent) return
					const peers = await loadPeers(username, groupId)
					const remoteNodeId = peerToNode.get(peerId)
					if (remoteNodeId && isSubjectBlocked(peers, remoteNodeId)) return
					const sender = signedEvent.sender?.trim() || ''
					if (sender && isSubjectBlocked(peers, sender)) return
					const eventId = signedEvent.id
					if (hasSeenFederationEvent(username, groupId, eventId)) return
					await ingestRemoteEvent(username, groupId, signedEvent)
					markSeenFederationEvent(username, groupId, eventId)
					if (remoteNodeId)
						await bumpReputationOnRelay(username, groupId, remoteNodeId, `dag:${eventId}`)
				})().catch(console.error)
			})
			const [sendGossipRequestRaw, getGossipRequest] = room.makeAction('gossip_request')
			const [sendGossipResponseRaw, getGossipResponse] = room.makeAction('gossip_response')
			const [sendChannelHistoryWantRaw, getChannelHistoryWant] = room.makeAction('channel_history_want')
			const [sendChannelHistoryResponseRaw, getChannelHistoryResponse] = room.makeAction('channel_history_response')
			const [sendFedVolatileRaw, getFedVolatileRaw] = room.makeAction('fed_volatile')
			const [sendFedTipPingRaw, getFedTipPing] = room.makeAction('fed_tip_ping')
			const [sendFedTipPongRaw, getFedTipPong] = room.makeAction('fed_tip_pong')

			getFedVolatileRaw((data, peerId) => {
				void handleIncomingFedVolatile(username, groupId, data, peerId, peerToNode)
					.catch(error => console.error('federation: fed_volatile failed', error))
			})

			getFedTipPing((data, peerId) => {
				void (async () => {
					const tipPing = parseFedTipPing(data)
					if (!tipPing) return
					const remoteNodeId = peerToNode.get(peerId) || tipPing.nodeId
					const peers = await loadPeers(username, groupId)
					if (isSubjectBlocked(peers, remoteNodeId)) return
					ingestRemoteTipsForExchange(username, groupId, tipPing.tips)
					const { readJsonl: readJsonlLocal } = requireDagDeps()
					const localEv = await readJsonlLocal(eventsPath(username, groupId))
					const pong = { nodeId, tips: computeDagTipIdsFromEvents(localEv) }
					fedOut.enqueue(3, () => {
						try {
							sendFedTipPongRaw(pong, peerId)
						}
						catch (error) {
							console.error('federation: fed_tip_pong failed', error)
						}
					})
				})().catch(error => console.error('federation: fed_tip_ping failed', error))
			})

			getFedTipPong((data, peerId) => {
				const tipPong = parseFedTipPong(data)
				if (!tipPong) return
				ingestRemoteTipsForExchange(username, groupId, tipPong.tips)
			})
			getGossipRequest((data, peerId) => {
				void (async () => {
					const gossipRequest = parseGossipRequest(data)
					if (!gossipRequest) return
					const { wantIds, ttl, requesterId, archiveSummary, attestation } = gossipRequest
					const { nodeId, readJsonl } = requireDagDeps()
					if (requesterId === nodeId) return
					const peers = await loadPeers(username, groupId)
					if (isSubjectBlocked(peers, attestation.requesterPubKeyHash)) return
					const fedState = await loadFederationMaterializedState(username, groupId)
					if (!fedState || !await validatePullAttestationForGroup(fedState, groupId, attestation)) return
					const recipientEdPubKeyHex = resolveMemberEdPubKeyHex(fedState, attestation.requesterPubKeyHash)
					if (!recipientEdPubKeyHex) return
					const dedupeKey = `${requesterId}\0${wantIds.slice().sort().join(',')}\0${ttl}`
					if (!takeGossipRequestSlot(dedupeKey)) return
					const groupSettingsIn = await loadFederationGroupSettings(username, groupId)
					if (!takeIncomingWantIdsSlot(
						username,
						groupId,
						requesterId,
						wantIdsLimitsFromSettings(groupSettingsIn),
					)) return

					const localArchive = await loadLocalFederationArchive(username, groupId, readJsonl)
					const handshake = evaluateArchiveHandshake(
						archiveSummary,
						localArchive.summary,
						localArchive.events,
						wantIds,
					)
					if (!handshake.allow) return

					const localEvents = localArchive.events
					const byId = new Map(localEvents.map(event => [event.id, event]))
					const allUnknown = wantIds.length > 0 && wantIds.every(id => !byId.has(id))
					if (allUnknown && localEvents.length > 0 && handshake.strictAligned)
						void recordGossipAllUnknownWant(username, groupId, requesterId).catch(console.error)

					const events = wantIds.map(id => byId.get(id)).filter(Boolean)
					if (peerId && events.length) {
						const envelope = await buildPullResponseEnvelope(username, groupId, {
							requestId: '',
							requesterNodeId: requesterId,
							requesterPubKeyHash: attestation.requesterPubKeyHash,
							recipientEdPubKeyHex,
							events,
							checkpoint: localArchive.checkpoint || undefined,
						})
						fedOut.enqueue(2, () => {
							try {
								sendGossipResponseRaw(envelope, peerId)
							}
							catch (error) {
								console.error('federation: gossip_response failed', error)
							}
						})
						void bumpReputationOnRelay(
							username,
							groupId,
							requesterId,
							`gossip:${dedupeKey}`,
						).catch(error => console.warn('federation: gossip reputation update failed', error))
					}

					const groupSettings = await loadFederationGroupSettings(username, groupId)
					const { gossipTtl: maxTtl } = resolveFederationPoolLimits(groupSettings)
					const forwardTtl = Math.min(ttl, maxTtl)
					if (forwardTtl > 0) {
						const roster = [...peerToNode.entries()].map(([peerId, remoteNodeId]) => ({ peerId, remoteNodeId }))
						const forwardPeers = await pickFederationTargetPeerIds(
							username,
							groupId,
							roster,
							groupSettings,
							nodeId,
						)
						const forwardPayload = {
							wantIds,
							ttl: forwardTtl - 1,
							requesterId,
							archiveSummary,
							attestation,
						}
						fedOut.enqueue(1, () => {
							try {
								if (forwardPeers.length)
									for (const forwardPeerId of forwardPeers)
										sendGossipRequestRaw(forwardPayload, forwardPeerId)
								else
									sendGossipRequestRaw(forwardPayload, null)
							}
							catch (error) {
								console.error('federation: gossip_request forward failed', error)
							}
						})
					}
				})().catch(console.error)
			})
			getGossipResponse(data => {
				void handleGossipResponse(username, groupId, data).catch(console.error)
			})
			getChannelHistoryWant((data, peerId) => {
				void (async () => {
					const historyWant = parseChannelHistoryWant(data, nodeId)
					if (!historyWant) return
					const { requesterId, requestId, channelId, before, limit } = historyWant
					const peers = await loadPeers(username, groupId)
					if (isSubjectBlocked(peers, requesterId)) return
					const { listChannelMessages } = await import('../dag/queries.mjs')
					const messages = await listChannelMessages(username, groupId, channelId, {
						before,
						limit,
						limitCap: 500,
						decrypt: false,
					})
					if (!messages.length || !peerId) return
					fedOut.enqueue(2, () => {
						try {
							sendChannelHistoryResponseRaw({
								requesterId,
								requestId,
								channelId,
								messages,
							}, peerId)
						}
						catch (error) {
							console.error('federation: channel_history_response failed', error)
						}
					})
				})().catch(console.error)
			})
			getChannelHistoryResponse(data => {
				void handleChannelHistoryResponse(username, groupId, data).catch(console.error)
			})
			/** @type {FederationSlot} */
			const slot = {
				partitionId,
				trysteroRoomName,
				room,
				/**
				 * DAG 出站（prio 0，经联邦队列）。
				 * @param {unknown} payload 事件载荷
				 * @param {string | null} peerId Trystero 目标或对等广播用的 null
				 * @returns {void}
				 */
				sendDag: (payload, peerId) =>
					fedOut.enqueue(0, () => {
						try {
							sendDagRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendDag failed', error)
						}
					}),
				/**
				 * Gossip want 出站（prio 1）。
				 * @param {unknown} payload gossip 载荷
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendGossipRequest: (payload, peerId) =>
					fedOut.enqueue(1, () => {
						try {
							sendGossipRequestRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendGossipRequest failed', error)
						}
					}),
				/**
				 * Gossip 应答出站（prio 2）。
				 * @param {unknown} payload 应答载荷
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendGossipResponse: (payload, peerId) =>
					fedOut.enqueue(2, () => {
						try {
							sendGossipResponseRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendGossipResponse failed', error)
						}
					}),
				/**
				 * 频道历史问询（prio 2）。
				 * @param {unknown} payload 问询载荷
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendChannelHistoryWant: (payload, peerId) =>
					fedOut.enqueue(2, () => {
						try {
							sendChannelHistoryWantRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: channel_history_want failed', error)
						}
					}),
				/**
				 * VOLATILE 等价最佳努力通道（prio 10，拥塞时先丢）。
				 * @param {unknown} payload 任意 JSON 可序列化体
				 * @param {string | null} peerId 目标或对等 null
				 * @returns {void}
				 */
				sendFedVolatile: (payload, peerId) =>
					fedOut.enqueue(10, () => {
						try {
							sendFedVolatileRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendFedVolatile failed', error)
						}
					}),
				/**
				 * DAG 叶交换 ping（prio 3）。
				 * @param {unknown} payload ping 体
				 * @param {string | null} peerId 目标
				 * @returns {void}
				 */
				sendTipPing: (payload, peerId) =>
					fedOut.enqueue(3, () => {
						try {
							sendFedTipPingRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendTipPing failed', error)
						}
					}),
				/**
				 * 跨分区桥接（prio 5；RTC 过载时由调用方跳过）。
				 * @param {unknown} envelope 桥接信封
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendPartitionBridge: (envelope, peerId) =>
					fedOut.enqueue(5, () => {
						if (!isFederationActionAllowedUnderLoad(key, 'fed_partition_bridge', rtcLimits)) return
						try {
							sendPartitionBridgeRaw(envelope, peerId)
						}
						catch (error) {
							console.error('federation: fed_partition_bridge failed', error)
						}
					}),
				/**
				 * @returns {{ peerId: string, remoteNodeId: string | undefined }[]} Trystero 对等端与本机推断的 `node_id`
				 */
				getRoster() {
					return [...peerToNode.entries()].map(([peerId, remoteNodeId]) => ({ peerId, remoteNodeId }))
				},
				/**
				 * @param {string} targetNodeId 目标节点 id
				 * @returns {string | null} 在线对应的 Trystero peerId，未知时为 null
				 */
				getPeerIdByNodeId(targetNodeId) { return nodeToPeer.get(targetNodeId) ?? null },
				/**
				 * @param {string} peerId 目标 Trystero peer id
				 * @param {string} actionName Trystero action 名称
				 * @param {unknown} payload 发送载荷
				 */
				sendToPeer(peerId, actionName, payload) { getActionSender(actionName)(payload, peerId) },
				/**
				 * MQTT bootstrap 请求（prio 2）。
				 * @param {unknown} payload 请求体
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendBootstrapRequest: (payload, peerId) =>
					fedOut.enqueue(2, () => {
						try {
							sendBootstrapRequestRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendBootstrapRequest failed', error)
						}
					}),
				/**
				 * MQTT bootstrap 响应（prio 2）。
				 * @param {unknown} payload 响应体
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendBootstrapResponse: (payload, peerId) =>
					fedOut.enqueue(2, () => {
						try {
							sendBootstrapResponseRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendBootstrapResponse failed', error)
						}
					}),
				/**
				 * 入群快照请求（prio 2）。
				 * @param {unknown} payload 请求载荷
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendJoinSnapshotRequest: (payload, peerId) =>
					fedOut.enqueue(2, () => {
						try {
							sendJoinSnapshotRequestRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: fed_join_snapshot_request failed', error)
						}
					}),
				mqttPassword: mqttCreds.password,
				/**
				 * 群发现广告（prio 3）。
				 * @param {unknown} payload 广告列表
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendDiscoveryAnnounce: (payload, peerId) =>
					fedOut.enqueue(3, () => {
						try {
							sendDiscoveryAnnounceRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendDiscoveryAnnounce failed', error)
						}
					}),
				/**
				 * 群发现查询（prio 3）。
				 * @param {unknown} payload 查询体
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendDiscoveryQuery: (payload, peerId) =>
					fedOut.enqueue(3, () => {
						try {
							sendDiscoveryQueryRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendDiscoveryQuery failed', error)
						}
					}),
				/**
				 * 群发现查询响应（prio 3）。
				 * @param {unknown} payload 响应体
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendDiscoveryQueryResponse: (payload, peerId) =>
					fedOut.enqueue(3, () => {
						try {
							sendDiscoveryQueryResponseRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendDiscoveryQueryResponse failed', error)
						}
					}),
				/**
				 * Mailbox 投递（prio 4）。
				 * @param {unknown} payload 记录体
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendMailboxPut: (payload, peerId) =>
					fedOut.enqueue(4, () => {
						try {
							sendMailboxPutRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendMailboxPut failed', error)
						}
					}),
				/**
				 * Mailbox 拉取请求（prio 4）。
				 * @param {unknown} payload want 体
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendMailboxWant: (payload, peerId) =>
					fedOut.enqueue(4, () => {
						try {
							sendMailboxWantRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendMailboxWant failed', error)
						}
					}),
				/**
				 * Mailbox 拉取响应（prio 4）。
				 * @param {unknown} payload give 体
				 * @param {string | null} peerId 目标 peer
				 * @returns {void}
				 */
				sendMailboxGive: (payload, peerId) =>
					fedOut.enqueue(4, () => {
						try {
							sendMailboxGiveRaw(payload, peerId)
						}
						catch (error) {
							console.error('federation: sendMailboxGive failed', error)
						}
					}),
			}
			const peersSnap = await loadPeers(username, groupId)
			/**
			 * @param {string} subject 节点 id 或 pubKeyHash
			 * @returns {boolean} 是否已拉黑
			 */
			const isBlockedPeer = subject => isSubjectBlocked(peersSnap, subject)
			attachFedChunkHandlers({
				username,
				groupId,
				room,
				peerToNode,
				isBlockedPeer,
				slot,
				fedOut,
				roomKey: key,
				rtcLimits,
			})
			attachFedEmojiHandlers({
				username,
				groupId,
				room,
				peerToNode,
				isBlockedPeer,
				slot,
			})
			if ((federationRoomRebindGeneration.get(key) || 0) !== genAtJoin) {
				unregisterChunkSwarm(username, groupId)
				return null
			}
			federationRooms.set(key, slot)
			groupFederationOwner.set(groupId, username)
			void publishDiscoveryAnnounceForGroup(username, groupId, nodeId, slot)
				.catch(error => console.warn('federation: initial discovery announce failed', error))
			void onFederationRoomReadyForMailbox(username, groupId)
				.catch(error => console.warn('federation: mailbox ready hook failed', error))
			return slot
		}
		catch (error) {
			console.error('federation: joinMqttRoom failed', error)
			return null
		}
		finally {
			federationRoomInflight.delete(key)
		}
	})()
	federationRoomInflight.set(key, roomJoinTask)
	return roomJoinTask
}
