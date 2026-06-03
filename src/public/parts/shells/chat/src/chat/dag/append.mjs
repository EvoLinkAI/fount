/**
 * 【文件】`dag/append.mjs` — 本地 DAG 事件追加主路径。
 */
import { Buffer } from 'node:buffer'
import { mkdir } from 'node:fs/promises'

import { publicKeyFromSeed, sign } from '../../../../../../../scripts/p2p/crypto.mjs'
import {
	computeEventId,
	signPayloadBytes,
} from '../../../../../../../scripts/p2p/dag/index.mjs'
import { readJsonl } from '../../../../../../../scripts/p2p/dag/storage.mjs'
import { getNodeHash } from '../../../../../../../scripts/p2p/node_context.mjs'
import { computeAppendHlcAndPrev } from '../../../../../../../scripts/p2p/timeline/append_core.mjs'
import {
	classifyHlcSkewAction,
	resolveHlcMaxSkewMs,
} from '../events/hlcPolicy.mjs'
import { sanitizeFederatedEvent } from '../events/wire.mjs'
import { checkMessageRateLimit } from '../governance/messageRateLimit.mjs'
import { groupDir, eventsPath } from '../lib/paths.mjs'

import { canonicalizeSignedChatEvent } from './canonicalizeEvent.mjs'
import { commitSignedChatEvent } from './commitSignedEvent.mjs'
import { validateIngestAuthz } from './ingest.mjs'
import { resolveLocalEventSigner } from './localSigner.mjs'
import { getState } from './materialize.mjs'
import { releaseQuarantinedEvents } from './remoteIngest.mjs'
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
	const { state } = await getState(username, groupId)

	if (BATTERY_SAVER_BLOCKED_LOCAL_TYPES.has(event.type) && state.groupSettings?.batterySaver)
		throw new Error(`batterySaver mode: governance event '${event.type}' is read-only`)

	const rateCheck = await checkMessageRateLimit(username, groupId, state, event)
	if (!rateCheck.ok) throw new Error(rateCheck.reason || 'message rate limit exceeded')

	await validateIngestAuthz(username, groupId, event, { source: 'local', state })
	await mkdir(groupDir(username, groupId), { recursive: true })
	const previous = await readJsonl(eventsPath(username, groupId), { sanitize: sanitizeFederatedEvent })
	const { hlc, prev_event_ids: prevFromCaller } = computeAppendHlcAndPrev(previous, event, { multiTip: true })

	const base = {
		...event,
		groupId,
		hlc,
		prev_event_ids: prevFromCaller,
		node_id: event.node_id || getNodeHash(username),
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

	const maxSkewMs = resolveHlcMaxSkewMs(state)
	const hlcAction = classifyHlcSkewAction(signPayload, maxSkewMs, { source: 'local' })
	if (hlcAction !== 'allow')
		throw new Error(`event HLC skew too large (${signPayload.type}, max ${maxSkewMs}ms)`)
	await validateSignature(username, groupId, body, signPayload, event, secretKey, state)

	const wirePayload = canonicalizeSignedChatEvent(signPayload)
	await commitSignedChatEvent(username, groupId, wirePayload, {
		checkpointOwnerSecretKey: secretKey,
		publishFederation: true,
	})
	await releaseQuarantinedEvents(username, groupId)

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
