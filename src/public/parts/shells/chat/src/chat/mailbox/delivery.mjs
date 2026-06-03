/**
 * Mailbox 投递：TrustGraph fanout + 本地 ingest。
 */
import { normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { fanoutMailboxPut, fanoutMailboxWant } from '../../../../../../../scripts/p2p/mailbox/fanout.mjs'
import {
	allowMailboxRelayForTier,
	defaultTtlMsForTier,
	scoreMailboxImportance,
} from '../../../../../../../scripts/p2p/mailbox_importance.mjs'
import { takeIncomingMailboxPutSlot } from '../../../../../../../scripts/p2p/mailbox_rate.mjs'
import { loadReputation } from '../../../../../../../scripts/p2p/reputation_user.mjs'
import { resolveLocalEventSigner } from '../dag/localSigner.mjs'
import { appendValidatedRemoteEvent } from '../dag/remoteIngest.mjs'
import { federationNodeHash } from '../federation/deps.mjs'

import { isKnownMailboxSubject } from './memberIndex.mjs'
import {
	deleteMailboxRecords,
	getMailboxRecords,
	listMailboxIdsForRecipient,
	storeMailboxRecord,
	takeMailboxForRecipient,
} from './store.mjs'

const MAX_MAILBOX_HOP = 3

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object[]} rows 待 ingest 记录
 * @returns {Promise<number>} 成功 ingest 条数
 */
async function ingestMailboxRows(username, groupId, rows) {
	const delivered = []
	for (const row of rows) {
		if (row.groupId && row.groupId !== groupId) continue
		const status = await appendValidatedRemoteEvent(username, row.groupId || groupId, row.envelope, { logFailures: false })
		if (status === 'ok' || status === 'dup') delivered.push(row.id)
	}
	if (delivered.length) await deleteMailboxRecords(username, delivered)
	return delivered.length
}

/**
 * @param {string} username 用户
 * @param {object} signedEvent 已签名 DAG 事件
 * @param {string} toPubKeyHash 收件人 pubKeyHash
 * @param {{ groupId?: string, channelId?: string, dmSessionTag?: string }} [meta] 元数据
 * @returns {Promise<void>}
 */
export async function dispatchMailboxMessage(username, signedEvent, toPubKeyHash, meta = {}) {
	const nodeHash = federationNodeHash(username)
	await storeMailboxRecord(username, {
		toPubKeyHash,
		groupId: meta.groupId || signedEvent.groupId,
		channelId: meta.channelId || signedEvent.channelId,
		dmSessionTag: meta.dmSessionTag,
		envelope: signedEvent,
		fromNodeHash: nodeHash,
		hop: 0,
		tier: 'trusted',
		importance: 1,
	})
	await fanoutMailboxPut(username, {
		nodeHash,
		record: {
			toPubKeyHash: normalizeHex64(toPubKeyHash),
			groupId: meta.groupId,
			channelId: meta.channelId,
			dmSessionTag: meta.dmSessionTag,
			envelope: signedEvent,
			hop: 0,
		},
	})
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {Promise<number>} ingest 条数
 */
export async function pullMailboxForLocalMember(username, groupId) {
	const { sender } = await resolveLocalEventSigner(username, groupId)
	return ingestMailboxRows(username, groupId, await takeMailboxForRecipient(username, sender))
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {Promise<void>}
 */
export async function onFederationRoomReadyForMailbox(username, groupId) {
	await pullMailboxForLocalMember(username, groupId)
	const { sender } = await resolveLocalEventSigner(username, groupId)
	await requestMailboxFromNetwork(username, sender)
}

/**
 * @param {string} username 用户
 * @param {string} toPubKeyHash 收件人
 * @returns {Promise<void>}
 */
export async function requestMailboxFromNetwork(username, toPubKeyHash) {
	await fanoutMailboxWant(username, {
		toPubKeyHash: normalizeHex64(toPubKeyHash),
		ids: (await listMailboxIdsForRecipient(username, toPubKeyHash)).slice(0, 64),
	})
}

/**
 * @param {string} username 用户
 * @param {object} put mailbox_put 载荷
 * @returns {Promise<void>}
 */
export async function ingestMailboxPut(username, put) {
	const { record } = put
	if (!record?.envelope || !record?.toPubKeyHash) return
	const fromNode = String(put.nodeHash || '').trim()
	if (!fromNode || !takeIncomingMailboxPutSlot(username, fromNode)) return
	const hop = Number(record.hop) || 0
	const relayHop = hop + 1
	const sender = String(record.envelope?.sender || '').trim().toLowerCase()
	const known = await isKnownMailboxSubject(username, {
		pubKeyHash: sender,
		nodeHash: fromNode,
	})
	const groupId = String(record.groupId || put.groupId || '').trim()
	const rep = groupId ? loadReputation(username) : { byNodeHash: {} }
	const senderScore = Number(
		rep.byNodeHash?.[fromNode]?.score
		?? rep.byNodeHash?.[sender]?.score
		?? 0,
	)
	const { tier, score } = scoreMailboxImportance({
		senderScore,
		knownMember: known,
		hop,
	})
	const ttlMs = tier === 'quarantine' && !known
		? 6 * 3600 * 1000
		: defaultTtlMsForTier(tier)
	if (!tier) return
	if (!await storeMailboxRecord(username, {
		...record,
		fromNodeHash: fromNode,
		hop: relayHop,
		tier,
		importance: score,
		ttlMs,
	})) return
	if (hop >= MAX_MAILBOX_HOP) return
	if (!allowMailboxRelayForTier(tier)) return
	await fanoutMailboxPut(username, {
		nodeHash: put.nodeHash,
		record: { ...record, hop: relayHop, tier, importance: score },
	}, tier === 'trusted' ? 4 : 2)
}

/**
 * @param {string} username 用户
 * @param {object} want mailbox_want
 * @param {(payload: unknown, peerId: string) => void} sendGive 发送 give
 * @param {string} peerId 请求方 peer
 * @returns {Promise<void>}
 */
export async function respondMailboxWant(username, want, sendGive, peerId) {
	const recipient = normalizeHex64(want.toPubKeyHash)
	if (!recipient) return
	const ids = Array.isArray(want.ids) ? want.ids : []
	const rows = (ids.length
		? await getMailboxRecords(username, ids)
		: await takeMailboxForRecipient(username, recipient)
	).filter(row => row.toPubKeyHash === recipient && row.tier !== 'quarantine')
	if (!rows.length) return
	sendGive({ toPubKeyHash: recipient, records: rows.slice(0, 32) }, peerId)
}

/**
 * @param {string} username 用户
 * @param {string} groupId 默认 ingest 群
 * @param {object} give mailbox_give
 * @returns {Promise<number>} 成功 ingest 条数
 */
export async function ingestMailboxGive(username, groupId, give) {
	return ingestMailboxRows(username, groupId, give.records || [])
}

/**
 * mailbox Put/Want/Give 联邦 wire 载荷解析（自 wire.mjs 再导出）。
 */
export { parseMailboxPut, parseMailboxWant, parseMailboxGive } from './wire.mjs'
