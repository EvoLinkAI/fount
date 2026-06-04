/**
 * 冷归档按月联邦拉取：PullAttestation + chunk meta + 多 peer 信誉 digest 仲裁。
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { penalizeArchiveServeMismatch } from '../../../../../../../scripts/p2p/reputation_user.mjs'
import { loadArchiveManifest, saveArchiveManifest } from '../archive/index.mjs'
import {
	prepareArchiveMonthChunkMeta,
	resolveArchiveMonthCandidateBody,
} from '../archive/monthChunks.mjs'
import {
	digestArchiveMonthBody,
	pickArchiveMonthByReputation,
} from '../archive/monthDigest.mjs'
import { assertArchiveSealChainValid } from '../archive/seal.mjs'
import { archiveMonthKey } from '../archive/settings.mjs'
import { pickFederationTargetPeerIds } from '../governance/peerPool.mjs'
import { channelArchivePath } from '../lib/paths.mjs'

import { markArchiveMonthIncomplete } from './archiveMonthMark.mjs'
import { federationNodeHash, loadFederationGroupSettings, loadFederationMaterializedState } from './deps.mjs'
import {
	signPullAttestation,
	validateActivePullAttestationForGroup,
} from './pullAttestation.mjs'
import { loadGroupSyncState } from './syncState.mjs'

/**
 *
 */
export { parseFedArchiveMonthResponse, parseFedArchiveMonthWant } from './archiveMonthWire.mjs'

const WAIT_MS = 5000

/** @type {Map<string, { candidates: object[], resolve: (v: object | null) => void, timer: ReturnType<typeof setTimeout> }>} */
const pendingMonthPulls = new Map()

/**
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {string} requestId 请求 id
 * @returns {string} 等待键
 */
function monthPullWaitKey(username, groupId, requestId) {
	return `${username}\0${groupId}\0${requestId}`
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} request want
 * @param {string} peerId 对端
 * @param {(payload: unknown, peerId: string) => void} sendResponse 发送
 * @returns {Promise<void>}
 */
export async function handleFedArchiveMonthWant(username, groupId, request, peerId, sendResponse) {
	if (request.groupId !== groupId) return
	const fedState = await loadFederationMaterializedState(username, groupId)
	if (!fedState || !await validateActivePullAttestationForGroup(fedState, groupId, request.attestation))
		return
	const path = channelArchivePath(username, groupId, request.channelId, request.utcMonth)
	const manifest = await loadArchiveManifest(username, groupId)
	const seal = manifest.seals?.[request.channelId] || null
	let bodyUtf8 = ''
	try {
		bodyUtf8 = await readFile(path, 'utf8')
	}
	catch {
		sendResponse({
			requestId: request.requestId,
			channelId: request.channelId,
			utcMonth: request.utcMonth,
			complete: false,
			reason: 'missing',
			digest: '',
			parts: [],
			seal,
		}, peerId)
		return
	}
	const { digest, parts } = await prepareArchiveMonthChunkMeta(username, bodyUtf8)
	sendResponse({
		requestId: request.requestId,
		channelId: request.channelId,
		utcMonth: request.utcMonth,
		complete: true,
		digest,
		parts,
		seal,
	}, peerId)
}

/**
 * 收集对端单月归档应答（多 peer 仲裁用）。
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} response 响应
 * @param {string} peerNodeHash 对端 nodeHash
 * @returns {void}
 */
export function noteFedArchiveMonthResponse(username, groupId, response, peerNodeHash) {
	const key = monthPullWaitKey(username, groupId, response.requestId)
	const pending = pendingMonthPulls.get(key)
	if (!pending) return
	pending.candidates.push({
		peerNodeHash: String(peerNodeHash || '').trim(),
		digest: response.digest,
		parts: response.parts,
		seal: response.seal,
		complete: response.complete,
		reason: response.reason,
	})
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} winner 仲裁赢家
 * @returns {Promise<{ applied: boolean }>} 是否写入
 */
export async function applyArchiveMonthWinner(username, groupId, winner) {
	if (!winner?.channelId || !winner?.utcMonth || winner.body == null) return { applied: false }
	const manifest = await loadArchiveManifest(username, groupId)
	if (winner.seal) {
		const localSeal = manifest.seals?.[winner.channelId] || null
		if (!await assertArchiveSealChainValid(username, groupId, winner.channelId, winner.seal, localSeal))
			return { applied: false }
	}
	const { digest } = digestArchiveMonthBody(winner.body)
	const { writeFile, mkdir } = await import('node:fs/promises')
	const { dirname } = await import('node:path')
	const path = channelArchivePath(username, groupId, winner.channelId, winner.utcMonth)
	await mkdir(dirname(path), { recursive: true })
	const bodyText = winner.body.endsWith('\n') ? winner.body : `${winner.body}\n`
	await writeFile(path, bodyText, 'utf8')
	if (!manifest.channels[winner.channelId]) manifest.channels[winner.channelId] = { months: [] }
	if (!manifest.channels[winner.channelId].months.includes(winner.utcMonth))
		manifest.channels[winner.channelId].months.push(winner.utcMonth)
	if (!manifest.monthDigests) manifest.monthDigests = {}
	if (!manifest.monthDigests[winner.channelId]) manifest.monthDigests[winner.channelId] = {}
	if (digest) manifest.monthDigests[winner.channelId][winner.utcMonth] = digest
	if (manifest.coverage?.[winner.channelId]) delete manifest.coverage[winner.channelId]
	manifest.archive_coverage_complete = Object.values(manifest.coverage || {})
		.every(row => row?.complete !== false)
	await saveArchiveManifest(username, groupId, manifest)
	return { applied: true }
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} slot 联邦槽
 * @param {Array<object>} candidates 原始候选
 * @returns {Promise<object[]>} 含 body 的候选
 */
async function resolveArchiveMonthCandidates(username, groupId, slot, candidates) {
	/** @type {object[]} */
	const resolved = []
	for (const row of candidates) {
		const body = await resolveArchiveMonthCandidateBody(username, groupId, slot, row)
		if (body === null) {
			if (row.peerNodeHash)
				penalizeArchiveServeMismatch(username, groupId, row.peerNodeHash)
			continue
		}
		resolved.push({ ...row, body })
	}
	return resolved
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} slot 联邦槽
 * @param {string} channelId 频道
 * @param {string} utcMonth `YYYY-MM`
 * @returns {Promise<{ applied: boolean, reason: string }>} 拉取结果
 */
export async function pullArchiveMonthQuorum(username, groupId, slot, channelId, utcMonth) {
	const nodeHash = federationNodeHash(username)
	const groupSettings = await loadFederationGroupSettings(username, groupId)
	const targets = await pickFederationTargetPeerIds(
		username,
		groupId,
		slot.getRoster(),
		groupSettings,
		nodeHash,
	)
	const requestId = randomUUID()
	const attestation = await signPullAttestation(username, groupId, { requestId })
	const request = {
		requestId,
		groupId,
		channelId,
		utcMonth,
		requesterNodeHash: nodeHash,
		attestation,
	}
	const waitKey = monthPullWaitKey(username, groupId, requestId)
	const collectPromise = new Promise(resolve => {
		const timer = setTimeout(() => {
			const bucket = pendingMonthPulls.get(waitKey)
			pendingMonthPulls.delete(waitKey)
			resolve(bucket?.candidates || [])
		}, WAIT_MS)
		pendingMonthPulls.set(waitKey, { candidates: [], timer })
	})
	if (targets.length)
		for (const peerId of targets)
			slot.send('fed_archive_month_want', request, peerId)
	else
		slot.send('fed_archive_month_want', request, null)

	const rawCandidates = await collectPromise
	if (!rawCandidates.length) {
		await markArchiveMonthIncomplete(username, groupId, channelId, utcMonth, 'timeout')
		return { applied: false, reason: 'timeout' }
	}

	const candidates = await resolveArchiveMonthCandidates(username, groupId, slot, rawCandidates)
	if (!candidates.length) {
		await markArchiveMonthIncomplete(username, groupId, channelId, utcMonth, 'chunk_fetch_failed')
		return { applied: false, reason: 'chunk_fetch_failed' }
	}

	const manifest = await loadArchiveManifest(username, groupId)
	const picked = await pickArchiveMonthByReputation(
		candidates,
		username,
		groupId,
		manifest,
		channelId,
		utcMonth,
	)
	if (!picked.winner) {
		for (const row of candidates)
			if (row.peerNodeHash)
				penalizeArchiveServeMismatch(username, groupId, row.peerNodeHash)
		await markArchiveMonthIncomplete(username, groupId, channelId, utcMonth, picked.reason)
		return { applied: false, reason: picked.reason }
	}

	const winnerDigest = picked.digest
	for (const row of candidates) {
		if (!row.peerNodeHash || !row.complete || row.body == null) continue
		const { digest } = digestArchiveMonthBody(row.body)
		if (digest && digest !== winnerDigest)
			penalizeArchiveServeMismatch(username, groupId, row.peerNodeHash)
	}

	const applied = (await applyArchiveMonthWinner(username, groupId, picked.winner)).applied
	return { applied, reason: applied ? 'ok' : 'apply_failed' }
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} slot 联邦槽
 * @returns {Promise<{ pulled: number, incomplete: number }>} 统计
 */
export async function pullOfflineStartUtcMonthArchives(username, groupId, slot) {
	const sync = await loadGroupSyncState(username, groupId)
	const utcMonth = sync.offlineStartUtcMonth
		|| (sync.offlineStartedAt ? archiveMonthKey(sync.offlineStartedAt) : '')
	if (!utcMonth) return { pulled: 0, incomplete: 0 }

	const manifest = await loadArchiveManifest(username, groupId)
	const channels = Object.keys(manifest.channels || {})
	if (!channels.length) {
		const { getState } = await import('../dag/materialize.mjs')
		const { state } = await getState(username, groupId)
		for (const channelId of Object.keys(state.channels || {}))
			channels.push(channelId)
	}

	let pulled = 0
	let incomplete = 0
	for (const channelId of channels) {
		try {
			await readFile(channelArchivePath(username, groupId, channelId, utcMonth), 'utf8')
			continue
		}
		catch { /* missing */ }

		const { applied } = await pullArchiveMonthQuorum(username, groupId, slot, channelId, utcMonth)
		if (applied) pulled++
		else incomplete++
	}
	return { pulled, incomplete }
}
