/**
 * 联邦补拉 HPKE 响应构建与应用。
 */
import { writeJsonAtomicSynced } from '../../../../../../../scripts/p2p/dag/storage.mjs'
import { extractInboundSignedEvent, isPlainObject } from '../../../../../../../scripts/p2p/wire_ingress.mjs'
import { getState } from '../dag/materialize.mjs'
import { mergeChannelHistories } from '../dag/queries.mjs'
import {
	encryptMessageLineForWire,
	encryptSignedEventForWire,
} from '../gsh/content.mjs'
import { applyGshGenerationGrant, buildGshGenerationGrant } from '../gsh/historicalGrant.mjs'
import { verifyRemoteCheckpoint } from '../lib/checkpointVerifier.mjs'
import { snapshotPath } from '../lib/paths.mjs'

import { requireDagDeps } from './deps.mjs'
import { wrapPullResponseInner, unwrapPullResponseEnvelope } from './pullResponse.mjs'

/**
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {object} opts 响应参数
 * @param {string} opts.requestId 请求 ID
 * @param {string} opts.requesterNodeHash 请求方 nodeId
 * @param {string} opts.requesterPubKeyHash 请求方 pubKeyHash
 * @param {string} opts.recipientEdPubKeyHex 接收方 Ed25519 公钥 hex
 * @param {object[]} [opts.events] DAG 事件
 * @param {Record<string, object[]>} [opts.channelHistories] 频道历史
 * @param {object} [opts.checkpoint] checkpoint
 * @param {object} [opts.archiveSummary] 存档摘要
 * @param {boolean} [opts.includeGshGrant] 是否附带历史 GSH grant
 * @returns {Promise<object>} HPKE envelope
 */
export async function buildPullResponseEnvelope(username, groupId, opts) {
	const {
		requestId,
		requesterNodeHash,
		requesterPubKeyHash,
		recipientEdPubKeyHex,
		events = [],
		channelHistories,
		checkpoint,
		archiveSummary,
		includeGshGrant = false,
	} = opts
	/** @type {Record<string, unknown>} */
	const inner = {}
	if (checkpoint) inner.checkpoint = checkpoint
	if (archiveSummary) inner.archiveSummary = archiveSummary
	if (events.length)
		inner.events = await Promise.all(events.map(ev => encryptSignedEventForWire(username, groupId, ev)))
	if (channelHistories && isPlainObject(channelHistories)) {
		/** @type {Record<string, object[]>} */
		const wireHistories = {}
		for (const [channelId, rows] of Object.entries(channelHistories)) {
			if (!Array.isArray(rows)) continue
			wireHistories[channelId] = await Promise.all(
				rows.map(row => encryptMessageLineForWire(username, groupId, channelId, row)),
			)
		}
		if (Object.keys(wireHistories).length)
			inner.channelHistories = wireHistories
	}
	if (includeGshGrant)
		inner.gshGrant = await buildGshGenerationGrant(username, groupId, recipientEdPubKeyHex)
	const wrapped = wrapPullResponseInner(recipientEdPubKeyHex, inner)
	return {
		requestId,
		requesterPubKeyHash,
		requesterNodeHash,
		...wrapped,
	}
}

/**
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {object} inner 解密后的 inner
 * @returns {Promise<{ eventsApplied: number, historiesMerged: number }>} 应用统计
 */
export async function applyPullInner(username, groupId, inner) {
	if (!isPlainObject(inner)) return { eventsApplied: 0, historiesMerged: 0 }
	if (inner.gshGrant)
		await applyGshGenerationGrant(username, groupId, inner.gshGrant)
	if (isPlainObject(inner.checkpoint)) {
		const checkpointResult = await verifyRemoteCheckpoint(inner.checkpoint, undefined)
			.catch(() => ({ valid: false }))
		if (checkpointResult.valid) {
			await writeJsonAtomicSynced(snapshotPath(username, groupId), inner.checkpoint)
			await getState(username, groupId, { skipWalRepair: true })
		}
	}
	let eventsApplied = 0
	const { appendValidatedRemoteEvent } = requireDagDeps()
	if (Array.isArray(inner.events))
		for (const rawEvent of inner.events) {
			const signedEvent = extractInboundSignedEvent(rawEvent, groupId)
			if (!signedEvent) continue
			if (await appendValidatedRemoteEvent(username, groupId, signedEvent, { logFailures: false }) === 'ok')
				eventsApplied++
		}
	let historiesMerged = 0
	if (isPlainObject(inner.channelHistories))
		historiesMerged = await mergeChannelHistories(username, groupId, inner.channelHistories)
	return { eventsApplied, historiesMerged }
}

/**
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {object} envelope HPKE envelope
 * @returns {Promise<object | null>} 解密后的 inner
 */
export async function unwrapPullEnvelopeForLocalMember(username, groupId, envelope) {
	const { resolveLocalEventSigner } = await import('../dag/localSigner.mjs')
	try {
		const { secretKey } = await resolveLocalEventSigner(username, groupId)
		return unwrapPullResponseEnvelope(envelope, secretKey)
	}
	catch {
		return null
	}
}
