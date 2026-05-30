/**
 * 【文件】`dag/append.mjs` — 本地 DAG 事件追加主路径。
 * 【职责】为本群分配 HLC、连接 DAG 前驱、验签后写入明文 content 的 `events.jsonl` 并触发广播与联邦发布。
 * 【原理】事件以 DAG 节点形式追加：`prev_event_ids` 指向当前 tip 或调用方指定父集；`nextHlc` 保证混序下的逻辑时钟；通过 `withGroupWriteLock` 串行化写盘；低电量模式拦截部分治理类事件。
 * 【数据结构】输入为未签名事件体；输出为含 `id`、`hlc`、`prev_event_ids`、`signature`、`senderPubKey` 的完整签名载荷。
 * 【关联】`events/hlcPolicy.mjs`、`events/wire.mjs`、`eventPersist.mjs`、`materialize.mjs`、`ingest.mjs`、`remoteIngest.mjs`。
 */
import { Buffer } from 'node:buffer'
import { mkdir } from 'node:fs/promises'

import { publicKeyFromSeed, sign } from '../../../../../../../scripts/p2p/crypto.mjs'
import {
	computeEventId,
	signPayloadBytes,
} from '../../../../../../../scripts/p2p/dag/index.mjs'
import { computeAppendHlcAndPrev } from '../../../../../../../scripts/p2p/timeline/append_core.mjs'
import {
	classifyHlcSkewAction,
	resolveHlcMaxSkewMs,
} from '../events/hlcPolicy.mjs'
import { recordEventReceivedAt } from '../events/meta.mjs'
import { groupDir, eventsPath } from '../lib/paths.mjs'

import { canonicalizeSignedChatEvent } from './canonicalizeEvent.mjs'
import { broadcastAndPersist } from './eventPersist.mjs'
import { withGroupWriteLock } from './groupLock.mjs'
import { validateIngestAuthz } from './ingest.mjs'
import { resolveLocalEventSigner } from './localSigner.mjs'
import { getState } from './materialize.mjs'
import { publishEventToFederation, releaseQuarantinedEvents } from './remoteIngest.mjs'
import { readJsonl, appendJsonlSynced } from './storage.mjs'
import { NODE_ID } from './syncScope.mjs'
import { unsignedEventFields, validateSignature } from './validator.mjs'

/** §2.1 低功耗模式下禁止本地发起的重量级治理变更类型。 */
const BATTERY_SAVER_BLOCKED_LOCAL_TYPES = new Set([
	'member_kick', 'member_ban', 'member_unban',
	'role_create', 'role_update', 'role_delete', 'role_assign', 'role_revoke',
	'channel_create', 'channel_update', 'channel_delete', 'channel_permissions_update',
	'group_settings_update',
	'key_rotate',
])

/**
 * 追加一条 DAG 事件：分配 HLC、可选本地签名、规则校验后写入并广播。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {object} event 待追加事件体
 * @param {Uint8Array} [secretKey] 若提供则以该密钥本地签发
 * @returns {Promise<object>} 写入后的完整签名载荷对象
 */
export async function appendEvent(username, groupId, event, secretKey) {
	if (BATTERY_SAVER_BLOCKED_LOCAL_TYPES.has(event.type)) {
		const { state } = await getState(username, groupId)
		if (state.groupSettings?.batterySaver)
			throw new Error(`batterySaver mode: governance event '${event.type}' is read-only`)
	}
	const { state: rateState } = await getState(username, groupId)
	const { checkMessageRateLimit } = await import('../governance/messageRateLimit.mjs')
	const rateCheck = await checkMessageRateLimit(username, groupId, rateState, event)
	if (!rateCheck.ok) throw new Error(rateCheck.reason || 'message rate limit exceeded')

	await validateIngestAuthz(username, groupId, event, { source: 'local' })
	await mkdir(groupDir(username, groupId), { recursive: true })
	const previous = await readJsonl(eventsPath(username, groupId))
	const { hlc, prev_event_ids: prevFromCaller } = computeAppendHlcAndPrev(previous, event, { multiTip: true })

	const base = {
		...event,
		groupId,
		hlc,
		prev_event_ids: prevFromCaller,
		node_id: event.node_id || NODE_ID,
	}
	const body = unsignedEventFields(base)
	const id = computeEventId(body)
	const signPayload = { ...body, id, signature: '' }
	if (secretKey) {
		const signature = await sign(signPayloadBytes(body), secretKey)
		signPayload.signature = Buffer.from(signature).toString('hex')
		signPayload.senderPubKey = Buffer.from(publicKeyFromSeed(secretKey)).toString('hex')
	}
	else {
		signPayload.signature = event.signature || ''
		if (event.senderPubKey) signPayload.senderPubKey = event.senderPubKey
	}

	const { state: stateForSignature } = await getState(username, groupId)
	const maxSkewMs = resolveHlcMaxSkewMs(stateForSignature)
	const hlcAction = classifyHlcSkewAction(signPayload, maxSkewMs, { source: 'local' })
	if (hlcAction !== 'allow')
		throw new Error(`event HLC skew too large (${signPayload.type}, max ${maxSkewMs}ms)`)
	await validateSignature(username, groupId, body, signPayload, event, secretKey, stateForSignature)

	const wirePayload = canonicalizeSignedChatEvent(signPayload)

	await withGroupWriteLock(username, groupId, async () => {
		await appendJsonlSynced(eventsPath(username, groupId), wirePayload)
		await recordEventReceivedAt(username, groupId, wirePayload.id, Date.now())
		await broadcastAndPersist(username, groupId, wirePayload, { checkpointOwnerSecretKey: secretKey })
		await releaseQuarantinedEvents(username, groupId)
	})
	await publishEventToFederation(username, groupId, wirePayload)
	const { recordMessageRate } = await import('../governance/rateLimitState.mjs')
	recordMessageRate(username, groupId, wirePayload)

	return signPayload
}

/**
 * 本机 HTTP 写路径：强制 `sender` 为 pubKeyHash 并签名后落盘。
 * @param {string} username 所有者
 * @param {string} groupId 群 ID
 * @param {object} event 事件体（勿设 sender）
 * @returns {Promise<object>} 签名后事件
 */
export async function appendSignedLocalEvent(username, groupId, event) {
	const { sender, secretKey } = await resolveLocalEventSigner(username, groupId)
	const eventBody = { ...event }
	delete eventBody.sender
	return appendEvent(username, groupId, { ...eventBody, sender }, secretKey)
}
