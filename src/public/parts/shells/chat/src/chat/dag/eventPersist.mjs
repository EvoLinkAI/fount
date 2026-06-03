/**
 * 【文件】`dag/eventPersist.mjs` — 事件落盘后的副作用管线。
 * 【职责】WebSocket 广播 DAG/频道消息、写频道 `messages.jsonl`、刷新 checkpoint、触发信誉/GSH/自动回复等钩子。
 * 【原理】非消息类事件仅重建 checkpoint；消息类解密展示内容后双播 `dag_event` 与 `channel_message`；信誉与 GSH 轮换在物化状态可用后异步应用。
 * 【数据结构】`messageLine` 含 `eventId`、`hlc`、`prev_event_ids`、`receivedAt`；房间键来自 `groupWsRoomKeyForReplica`。
 * 【关联】`materialize.mjs`、`events/meta.mjs`、`../stream/groupWsHub.mjs`、`../session/autoReply.mjs`。
 */
import { sortedPrevEventIds } from '../../../../../../../scripts/p2p/dag/index.mjs'
import { appendJsonlSynced, readJsonl } from '../../../../../../../scripts/p2p/dag/storage.mjs'
import {
	applyDecayCollusionAfterSlash,
	applyReputationResetToScores,
	applySubjectiveSlashFromEvent,
	seedMemberReputationFromIntroducer,
} from '../../../../../../../scripts/p2p/reputation_user.mjs'
import { getEventReceivedAt } from '../events/meta.mjs'
import { sanitizeFederatedEvent } from '../events/wire.mjs'
import { onMqttCredentialsSyncedFromDag, mqttCredentialsFromGroupSettings } from '../federation/mqttCredentials.mjs'
import { releaseFileChunksAfterDelete } from '../files/deleteGc.mjs'
import {
	decryptEventContent,
	GSH_ENCRYPT_EVENT_TYPES,
} from '../gsh/content.mjs'
import { tryImportHFromPeerInvite } from '../gsh/peerInviteImport.mjs'
import { applyGshRotationFromEvent } from '../gsh/store.mjs'
import { eventsPath, messagesPath } from '../lib/paths.mjs'
import { broadcastEvent } from '../stream/groupWsHub.mjs'
import { groupWsRoomKeyForReplica } from '../stream/groupWsRooms.mjs'


import { getState, rebuildAndSaveCheckpoint } from './materialize.mjs'

/** 写入频道消息流 JSONL 的事件类型。 */
const PERSIST_MESSAGE_TYPES = new Set([
	'message', 'message_edit', 'message_delete', 'message_feedback',
	'vote_cast', 'pin_message', 'unpin_message',
])

/**
 * @param {object} signPayload 已落盘事件
 * @returns {string} 目标成员 pubKeyHash（小写 hex），无效时为空串
 */
function slashTargetPubKeyHash(signPayload) {
	return signPayload.content?.targetPubKeyHash?.trim().toLowerCase() || ''
}

/**
 * @param {string} username 用户名
 * @param {string} groupId 群 ID
 * @param {object} signPayload 已落盘事件
 * @returns {Promise<void>}
 */
async function applyReputationHooks(username, groupId, signPayload) {
	if (!signPayload?.type) return

	if (signPayload.type === 'reputation_slash') {
		await applySubjectiveSlashFromEvent(username, groupId, signPayload, async (u, g) => readJsonl(eventsPath(u, g), { sanitize: sanitizeFederatedEvent }))
		const target = slashTargetPubKeyHash(signPayload)
		if (target) {
			const { state } = await getState(username, groupId)
			await applyDecayCollusionAfterSlash(username, target, state.inviteEdges || [])
		}
	}
	if (signPayload.type === 'member_kick' || signPayload.type === 'member_ban') {
		const target = slashTargetPubKeyHash(signPayload)
		if (target) {
			const { state } = await getState(username, groupId)
			await applyDecayCollusionAfterSlash(username, target, state.inviteEdges || [])
		}
	}
	if (signPayload.type === 'reputation_reset') {
		const target = slashTargetPubKeyHash(signPayload)
		if (target) await applyReputationResetToScores(username, target)
	}
	if (signPayload.type === 'member_join') {
		const sender = signPayload.sender.trim().toLowerCase()
		const { state } = await getState(username, groupId)
		const joinContent = signPayload.content || {}
		let introducer = joinContent.introducerPubKeyHash?.trim().toLowerCase() || ''
		let repEdge = 1
		for (const edge of [...state.inviteEdges || []].reverse())
			if (edge.to?.trim().toLowerCase() === sender) {
				introducer = edge.from?.trim().toLowerCase() || ''
				if (Number.isFinite(edge.reputationEdge)) repEdge = edge.reputationEdge
				break
			}

		const fromMember = state.members?.[sender]
		const edgeFromJoin = Number.isFinite(fromMember?.repEdgeFromIntroducer)
			? fromMember.repEdgeFromIntroducer
			: repEdge
		await seedMemberReputationFromIntroducer(username, sender, introducer, edgeFromJoin)
	}
}

/**
 * DAG 事件落盘后：WebSocket 广播、按需写频道消息行并刷新 checkpoint。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {object} signPayload 已持久化的签名事件对象
 * @param {{ checkpointOwnerSecretKey?: Uint8Array }} [persistOpts] checkpoint 签名私钥
 * @returns {Promise<void>}
 */
export async function broadcastAndPersist(username, groupId, signPayload, persistOpts = {}) {
	if (signPayload.type === 'file_delete' && signPayload.content?.fileId)
		try {
			const { state } = await getState(username, groupId)
			await releaseFileChunksAfterDelete(username, groupId, String(signPayload.content.fileId), state)
		}
		catch (error) {
			console.error('file_delete gc failed', error)
		}

	const roomKey = groupWsRoomKeyForReplica(username, groupId)
	broadcastEvent(roomKey, { type: 'dag_event', event: signPayload })
	try {
		await applyReputationHooks(username, groupId, signPayload)
	}
	catch (error) {
		console.error('reputation hooks failed', error)
	}
	try {
		await applyGshRotationFromEvent(username, groupId, signPayload)
	}
	catch (error) {
		console.error('gsh rotation hook failed', error)
	}
	try {
		await tryImportHFromPeerInvite(username, groupId, signPayload)
	}
	catch (error) {
		console.error('peer_invite GSH import failed', error)
	}
	if (!PERSIST_MESSAGE_TYPES.has(signPayload.type)) {
		await rebuildAndSaveCheckpoint(username, groupId, { ...persistOpts, skipChannelGc: true })
		return
	}
	const channelId = signPayload.channelId || signPayload.content?.channelId || 'default'
	const storedContent = signPayload.content
	let displayContent = storedContent
	let sidecarContent = storedContent
	if (GSH_ENCRYPT_EVENT_TYPES.has(signPayload.type)) {
		displayContent = await decryptEventContent(username, groupId, channelId, storedContent)
		if (displayContent?.gshDecryptFailed)
			sidecarContent = {
				decryptFailed: true,
				pendingGeneration: displayContent.gshPendingGeneration ?? null,
			}
		else
			sidecarContent = displayContent
	}
	const messageLine = {
		eventId: signPayload.id,
		type: signPayload.type,
		content: sidecarContent,
		sender: signPayload.sender,
		charId: signPayload.charId,
		timestamp: signPayload.timestamp,
		hlc: signPayload.hlc,
		prev_event_ids: sortedPrevEventIds(signPayload.prev_event_ids),
		receivedAt: await getEventReceivedAt(username, groupId, signPayload.id) ?? Date.now(),
	}
	await appendJsonlSynced(messagesPath(username, groupId, channelId), messageLine)
	broadcastEvent(roomKey, {
		type: 'channel_message',
		channelId,
		message: { ...messageLine, content: displayContent },
	})
	await rebuildAndSaveCheckpoint(username, groupId, { ...persistOpts, skipChannelGc: true })
	if (signPayload.type === 'message')
		void import('../session/autoReply.mjs').then(({ maybeAutoTriggerCharReply }) =>
			maybeAutoTriggerCharReply(username, groupId, channelId, displayContent, signPayload),
		).catch(error => {
			console.error('maybeAutoTriggerCharReply failed:', error)
		})
	if (signPayload.type === 'group_settings_update' && signPayload.content?.mqttRoomSecret) {
		const { state } = await getState(username, groupId)
		const creds = mqttCredentialsFromGroupSettings({ ...state.groupSettings, ...signPayload.content })
		if (creds) await onMqttCredentialsSyncedFromDag(username, groupId, creds)
	}
}
