/**
 * 【文件】`dag/remoteIngest.mjs` — 联邦/远程 DAG 事件入库。
 * 【职责】验 id、签名、封禁、HLC 策略与 GSH 后写入本地 `events.jsonl`；HLC 超 skew 的消息类事件进入隔离区；成功后广播并尝试释放隔离事件。
 * 【原理】远程事件须与本地 DAG 规范一致；治理类 HLC 超 skew 硬拒绝，消息类超 skew 写入 quarantine 待时钟恢复后重放；`ingestRemoteEvent` 解析 Trystero 入站载荷。
 * 【数据结构】返回 `'ok' | 'dup' | 'invalid' | 'quarantined'`；持久化前经 `sanitizeFederatedEvent`。
 * 【关联】`events/hlcPolicy.mjs`、`events/quarantine.mjs`、`eventPersist.mjs`、`ingest.mjs`、`../federation/index.mjs`。
 */
import { debugLog } from '../../../../../../../scripts/debug_log.mjs'
import { computeEventId } from '../../../../../../../scripts/p2p/dag/index.mjs'
import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { validateRemoteEventShape } from '../../../../../../../scripts/p2p/schemas/remote_event.mjs'
import {
	classifyHlcSkewAction,
	resolveHlcMaxSkewMs,
} from '../events/hlcPolicy.mjs'
import { recordEventReceivedAt } from '../events/meta.mjs'
import { appendQuarantinedEvent, replayQuarantinedEvents } from '../events/quarantine.mjs'
import { publishSignedEventToFederation } from '../federation/index.mjs'
import { isPubKeyHashBlocked, isSubjectBannedByState, isSubjectBlocked } from '../governance/blocklist.mjs'
import {
	assertFederatedGshContent,
} from '../gsh/content.mjs'
import { eventsPath } from '../lib/paths.mjs'
import { extractInboundSignedEvent } from '../lib/wireIngress.mjs'

import { canonicalizeSignedChatEvent } from './canonicalizeEvent.mjs'
import { broadcastAndPersist } from './eventPersist.mjs'
import { withGroupWriteLock } from './groupLock.mjs'
import { validateIngestAuthz } from './ingest.mjs'
import { getState } from './materialize.mjs'
import { readJsonl, appendJsonlSynced } from './storage.mjs'
import { PUB_KEY_HASH_HEX, unsignedEventFields, validateSignature } from './validator.mjs'

/**
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {object} signPayload 完整签名事件
 */
export async function publishEventToFederation(username, groupId, signPayload) {
	await publishSignedEventToFederation(username, groupId, signPayload)
}

/**
 * 校验远程 DAG 事件并追加到本地 `events.jsonl`。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {object} signPayload 完整签名事件
 * @param {{ logFailures?: boolean, skipQuarantineRelease?: boolean }} [opts] 日志与隔离重放选项
 * @returns {Promise<'ok' | 'dup' | 'invalid' | 'quarantined'>} 写入结果
 */
export async function appendValidatedRemoteEvent(username, groupId, signPayload, opts = {}) {
	const logFailures = opts.logFailures !== false
	if (!signPayload?.id) return 'invalid'

	const path = eventsPath(username, groupId)
	const previous = await readJsonl(path)
	if (previous.some(existing => existing.id === signPayload.id)) return 'dup'

	const bodyForId = unsignedEventFields(signPayload)
	if (computeEventId(bodyForId) !== signPayload.id) {
		if (logFailures) {
			console.error('federation: drop remote event (id mismatch)')
			await debugLog('remote-ingest-invalid', { username, groupId, reason: 'id_mismatch', eventId: signPayload.id }).catch(() => {})
		}
		return 'invalid'
	}

	const sender = String(signPayload.sender || '').trim()
	if (!PUB_KEY_HASH_HEX.test(sender)) {
		if (logFailures) console.error('federation: drop remote event (sender must be pubKeyHash)')
		return 'invalid'
	}

	const { state } = await getState(username, groupId)
	try {
		await validateSignature(username, groupId, bodyForId, signPayload, signPayload, undefined, state)
	}
	catch (error) {
		if (logFailures) {
			console.error('federation: drop remote event (signature)', error)
			await debugLog('remote-ingest-invalid', { username, groupId, reason: 'signature', eventId: signPayload.id, message: error?.message }).catch(() => {})
		}
		return 'invalid'
	}

	if (signPayload.type === 'reputation_reset') {
		const targetPubKeyHash = signPayload.content?.targetPubKeyHash?.trim().toLowerCase() || ''
		if (targetPubKeyHash && isPubKeyHashBlocked(username, targetPubKeyHash)) {
			if (logFailures) console.error('federation: drop reputation_reset (target locally blocked)')
			return 'invalid'
		}
	}

	const maxSkewMs = resolveHlcMaxSkewMs(state)
	const hlcAction = classifyHlcSkewAction(signPayload, maxSkewMs, { source: 'federation' })
	if (hlcAction === 'reject') {
		if (logFailures) console.error('federation: drop remote event (HLC skew)', signPayload.type)
		return 'invalid'
	}

	const senderKey = signPayload.sender?.trim().toLowerCase() || ''
	if (senderKey) {
		const member = state.members?.[senderKey]
		const homeNodeHash = String(member?.homeNodeHash || '').trim().toLowerCase()
		const subject = {
			pubKeyHash: senderKey,
			nodeHash: isHex64(homeNodeHash) ? homeNodeHash : undefined,
			entityHash: isHex64(homeNodeHash) ? `${homeNodeHash}${senderKey}` : undefined,
		}
		if (isSubjectBannedByState(state, subject) || isSubjectBlocked(username, subject)) {
			if (logFailures) console.error('federation: drop remote event (banned/blocked subject)')
			return 'invalid'
		}
		const { loadPeers, isSubjectBlocked: isPeerBlocked } = await import('../governance/peers.mjs')
		const peers = await loadPeers(username, groupId)
		if (isPeerBlocked(peers, senderKey)
			|| (subject.nodeHash && isPeerBlocked(peers, subject.nodeHash))
			|| (subject.entityHash && isPeerBlocked(peers, subject.entityHash))) {
			if (logFailures) console.error('federation: drop remote event (blocked peer)')
			return 'invalid'
		}
	}

	if (hlcAction === 'quarantine') {
		await withGroupWriteLock(username, groupId, async () => {
			await appendQuarantinedEvent(username, groupId, signPayload, 'hlc_skew')
		})
		return 'quarantined'
	}

	try {
		assertFederatedGshContent(String(signPayload.type), signPayload.content)
	}
	catch (error) {
		if (logFailures) console.error('federation: drop remote event (GSH required)', error)
		return 'invalid'
	}

	if (signPayload.type === 'message') {
		const rateCheck = await import('../governance/messageRateLimit.mjs').then(m =>
			m.checkMessageRateLimit(username, groupId, state, signPayload),
		)
		if (!rateCheck.ok) {
			const remoteNode = String(signPayload.node_id || '').trim()
			if (remoteNode) {
				const { recordMessageRateViolation } = await import('../governance/reputation.mjs')
				void recordMessageRateViolation(username, groupId, remoteNode).catch(() => {})
			}
			if (logFailures) console.error('federation: drop remote event (rate limit)')
			return 'invalid'
		}
	}

	try {
		validateRemoteEventShape(signPayload)
		await validateIngestAuthz(username, groupId, signPayload, { source: 'federation' })
	}
	catch (error) {
		if (logFailures) console.error('federation: drop remote event (ingest authz)', error)
		return 'invalid'
	}

	const wireEvent = canonicalizeSignedChatEvent(signPayload)
	const receivedAt = Date.now()

	await withGroupWriteLock(username, groupId, async () => {
		await appendJsonlSynced(path, wireEvent)
		await recordEventReceivedAt(username, groupId, String(wireEvent.id), receivedAt)
		await broadcastAndPersist(username, groupId, wireEvent, {})
		if (!opts.skipQuarantineRelease)
			await releaseQuarantinedEvents(username, groupId)
	})
	const { recordMessageRate } = await import('../governance/rateLimitState.mjs')
	recordMessageRate(username, groupId, wireEvent)
	if (wireEvent.type === 'group_settings_update' && wireEvent.content?.mqttRoomSecret) {
		const { onMqttCredentialsSyncedFromDag, mqttCredentialsFromGroupSettings } = await import('../federation/mqttCredentials.mjs')
		const { state: fresh } = await getState(username, groupId)
		const creds = mqttCredentialsFromGroupSettings(fresh.groupSettings)
		if (creds) await onMqttCredentialsSyncedFromDag(username, groupId, creds)
	}
	return 'ok'
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {Promise<void>}
 */
export async function releaseQuarantinedEvents(username, groupId) {
	await replayQuarantinedEvents(username, groupId, event =>
		appendValidatedRemoteEvent(username, groupId, event, {
			logFailures: false,
			skipQuarantineRelease: true,
		}),
	)
}

/**
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {unknown} payload Trystero 载荷或 `{ event }` 包装
 * @returns {Promise<void>}
 */
export async function ingestRemoteEvent(username, groupId, payload) {
	const signedEvent = extractInboundSignedEvent(payload, groupId)
	if (!signedEvent) return
	await appendValidatedRemoteEvent(username, groupId, signedEvent, { logFailures: true })
}

/**
 * checkpoint 后刷出 `pending_relay`：在已有物化快照下重新过联邦 ACL 再中继。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object} signPayload 签名事件
 * @returns {Promise<boolean>} 已中继则为 true
 */
export async function relayPendingFederatedEvent(username, groupId, signPayload) {
	const { canRelayFederatedEvent } = await import('../federation/acl.mjs')
	const { state } = await getState(username, groupId)
	if (!canRelayFederatedEvent(state, signPayload)) return false
	await publishSignedEventToFederation(username, groupId, signPayload)
	return true
}
