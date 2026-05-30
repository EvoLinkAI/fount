/**
 * 入群快照：checkpoint + GSH wire channelHistories + gshGrant（HPKE envelope）。
 */
import { randomUUID } from 'node:crypto'

import { rebuildAndSaveCheckpoint } from '../dag/materialize.mjs'
import { listChannelMessages } from '../dag/queries.mjs'
import { pickFederationTargetPeerIds } from '../governance/peerPool.mjs'
import { isSubjectBlocked, loadPeers } from '../governance/peers.mjs'
import { isPlainObject } from '../lib/wireIngress.mjs'

import { wireArchiveSummary, loadLocalFederationArchive } from './archiveHandshake.mjs'
import { loadFederationGroupSettings, loadFederationMaterializedState, requireDagDeps } from './deps.mjs'
import { resolveMemberEdPubKeyHex, signPullAttestation, validatePullAttestationForGroup } from './pullAttestation.mjs'
import {
	applyPullInner,
	buildPullResponseEnvelope,
	unwrapPullEnvelopeForLocalMember,
} from './pullEnvelope.mjs'

/**
 * 入群快照 Trystero 请求/响应载荷解析（自 joinSnapshotWire 再导出）。
 */
export { parseJoinSnapshotRequest, parseJoinSnapshotResponse } from './joinSnapshotWire.mjs'

/**
 * 入群快照响应中每频道附带的历史消息条数上限。
 */
export const JOIN_SNAPSHOT_PER_CHANNEL = 500
const SNAPSHOT_WAIT_MS = 4000

/** @type {Map<string, { resolve: (v: object | null) => void, timer: ReturnType<typeof setTimeout> }>} */
const pendingSnapshots = new Map()

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} requestId 请求 id
 * @returns {string} 等待表键
 */
function snapshotWaitKey(username, groupId, requestId) {
	return `${username}\0${groupId}\0${requestId}`
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object} envelope 解析后的 HPKE envelope
 * @returns {Promise<boolean>} 是否已应用
 */
export async function applyJoinSnapshotResponse(username, groupId, envelope) {
	const { nodeId } = requireDagDeps()
	if (envelope.requesterNodeId !== nodeId) return false
	const key = snapshotWaitKey(username, groupId, envelope.requestId)
	const pending = pendingSnapshots.get(key)
	if (pending) {
		clearTimeout(pending.timer)
		pendingSnapshots.delete(key)
		pending.resolve(envelope)
	}
	const inner = await unwrapPullEnvelopeForLocalMember(username, groupId, envelope)
	if (!inner) return false
	await applyPullInner(username, groupId, inner)
	return true
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object} request 解析后的请求
 * @param {string} peerId Trystero peer
 * @param {(payload: unknown, peerId: string) => void} sendResponse 发送响应
 * @returns {Promise<void>} 无返回值
 */
export async function handleJoinSnapshotRequest(username, groupId, request, peerId, sendResponse) {
	if (request.groupId !== groupId || !peerId) return
	const fedState = await loadFederationMaterializedState(username, groupId)
	if (!fedState) return
	if (!await validatePullAttestationForGroup(fedState, groupId, request.attestation)) return
	const peers = await loadPeers(username, groupId)
	if (isSubjectBlocked(peers, request.requesterPubKeyHash)) return
	const recipientEdPubKeyHex = resolveMemberEdPubKeyHex(fedState, request.requesterPubKeyHash)
	if (!recipientEdPubKeyHex) return

	const { readJsonl } = requireDagDeps()
	const checkpoint = await rebuildAndSaveCheckpoint(username, groupId, { skipChannelGc: true })
	const channelHistories = {}
	for (const channelId of Object.keys(fedState.channels || {}))
		channelHistories[channelId] = await listChannelMessages(username, groupId, channelId, {
			limit: JOIN_SNAPSHOT_PER_CHANNEL,
			limitCap: JOIN_SNAPSHOT_PER_CHANNEL,
			decrypt: false,
		})

	const localArchive = await loadLocalFederationArchive(username, groupId, readJsonl)
	const envelope = await buildPullResponseEnvelope(username, groupId, {
		requestId: request.requestId,
		requesterNodeId: request.requesterNodeId,
		requesterPubKeyHash: request.requesterPubKeyHash,
		recipientEdPubKeyHex,
		checkpoint,
		archiveSummary: wireArchiveSummary(localArchive.summary),
		channelHistories,
		includeGshGrant: true,
	})
	sendResponse(envelope, peerId)
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object} slot FederationSlot
 * @returns {Promise<{ applied: boolean, channels: number }>} 应用结果统计
 */
export async function requestJoinSnapshotFromPeers(username, groupId, slot) {
	const { nodeId, readJsonl } = requireDagDeps()
	const localArchive = await loadLocalFederationArchive(username, groupId, readJsonl)
	const requestId = randomUUID()
	const attestation = await signPullAttestation(username, groupId, { requestId })
	const request = {
		requestId,
		requesterNodeId: nodeId,
		requesterPubKeyHash: attestation.requesterPubKeyHash,
		groupId,
		tipsHash: localArchive.summary?.tipsHash || '',
		attestation,
	}
	const responsePromise = new Promise(resolve => {
		const timer = setTimeout(() => {
			pendingSnapshots.delete(snapshotWaitKey(username, groupId, requestId))
			resolve(null)
		}, SNAPSHOT_WAIT_MS)
		pendingSnapshots.set(snapshotWaitKey(username, groupId, requestId), { resolve, timer })
	})
	const groupSettings = await loadFederationGroupSettings(username, groupId)
	const roster = slot.getRoster()
	const targets = await pickFederationTargetPeerIds(username, groupId, roster, groupSettings, nodeId)
	if (targets.length)
		for (const peerId of targets)
			slot.sendJoinSnapshotRequest(request, peerId)
	else
		slot.sendJoinSnapshotRequest(request, null)

	const envelope = await responsePromise
	if (!envelope) return { applied: false, channels: 0 }
	const ok = await applyJoinSnapshotResponse(username, groupId, envelope)
	const inner = await unwrapPullEnvelopeForLocalMember(username, groupId, envelope)
	const channelCount = isPlainObject(inner?.channelHistories)
		? Object.keys(inner.channelHistories).length
		: 0
	return { applied: ok, channels: channelCount }
}
