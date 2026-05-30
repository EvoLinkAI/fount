/**
 * 入群快照：checkpoint + 明文 channelHistories（fed_join_snapshot_*）。
 */
import { randomUUID } from 'node:crypto'

import { getState, rebuildAndSaveCheckpoint } from '../dag/materialize.mjs'
import { listChannelMessages, mergeChannelHistories } from '../dag/queries.mjs'
import { writeJsonAtomicSynced } from '../dag/storage.mjs'
import { pickFederationTargetPeerIds } from '../governance/peerPool.mjs'
import { isSubjectBlocked, loadPeers } from '../governance/peers.mjs'
import { verifyRemoteCheckpoint } from '../lib/checkpointVerifier.mjs'
import { snapshotPath } from '../lib/paths.mjs'
import { isPlainObject } from '../lib/wireIngress.mjs'

import { wireArchiveSummary, loadLocalFederationArchive } from './archiveHandshake.mjs'
import { loadFederationGroupSettings, loadFederationMaterializedState, requireDagDeps } from './deps.mjs'
/**
 *
 */
export { parseJoinSnapshotRequest, parseJoinSnapshotResponse } from './joinSnapshotWire.mjs'

/**
 *
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
 * @param {object} response 解析后的响应
 * @returns {Promise<boolean>} 是否已应用
 */
export async function applyJoinSnapshotResponse(username, groupId, response) {
	const { nodeId } = requireDagDeps()
	if (response.requesterId !== nodeId) return false
	const key = snapshotWaitKey(username, groupId, response.requestId)
	const pending = pendingSnapshots.get(key)
	if (pending) {
		clearTimeout(pending.timer)
		pendingSnapshots.delete(key)
		pending.resolve(response)
	}
	if (isPlainObject(response.checkpoint)) {
		const checkpointResult = await verifyRemoteCheckpoint(response.checkpoint, undefined)
			.catch(() => ({ valid: false }))
		if (!checkpointResult.valid) return false
		await writeJsonAtomicSynced(snapshotPath(username, groupId), response.checkpoint)
		await getState(username, groupId, { skipWalRepair: true }).catch(() => {})
	}
	if (isPlainObject(response.channelHistories))
		await mergeChannelHistories(username, groupId, response.channelHistories)
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
	const peers = await loadPeers(username, groupId)
	if (isSubjectBlocked(peers, request.requesterId)) return
	const { nodeId, readJsonl } = requireDagDeps()
	const checkpoint = await rebuildAndSaveCheckpoint(username, groupId, { skipChannelGc: true })
	const channelHistories = {}
	for (const channelId of Object.keys(fedState.channels || {})) 
		channelHistories[channelId] = await listChannelMessages(username, groupId, channelId, {
			limit: JOIN_SNAPSHOT_PER_CHANNEL,
			limitCap: JOIN_SNAPSHOT_PER_CHANNEL,
			decrypt: true,
		})
	
	const localArchive = await loadLocalFederationArchive(username, groupId, readJsonl)
	sendResponse({
		requestId: request.requestId,
		requesterId: request.requesterId,
		responderNodeId: nodeId,
		checkpoint,
		archiveSummary: wireArchiveSummary(localArchive.summary),
		channelHistories,
	}, peerId)
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
	const request = {
		requestId,
		requesterId: nodeId,
		groupId,
		tipsHash: localArchive.summary?.tipsHash || '',
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

	const response = await responsePromise
	if (!response) return { applied: false, channels: 0 }
	const ok = await applyJoinSnapshotResponse(username, groupId, response)
	const channelCount = isPlainObject(response.channelHistories)
		? Object.keys(response.channelHistories).length
		: 0
	return { applied: ok, channels: channelCount }
}
