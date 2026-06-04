/**
 * 回归仅拉 `offlineStartUtcMonth` 单月冷归档；失败标 historyIncomplete。
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { materializeFromCheckpoint } from '../../../../../../../scripts/p2p/materialized_state.mjs'
import { isPlainObject } from '../../../../../../../scripts/p2p/wire_ingress.mjs'
import { loadArchiveManifest, saveArchiveManifest } from '../archive/index.mjs'
import { verifyArchiveSeal } from '../archive/seal.mjs'
import { archiveMonthKey } from '../archive/settings.mjs'
import { pickFederationTargetPeerIds } from '../governance/peerPool.mjs'
import { channelArchivePath, snapshotPath } from '../lib/paths.mjs'
import { safeReadJson } from '../lib/utils.mjs'

import { federationNodeHash, loadFederationGroupSettings } from './deps.mjs'
import { loadGroupSyncState } from './sync_state.mjs'

/** @type {Map<string, { resolve: (v: object | null) => void, timer: ReturnType<typeof setTimeout> }>} */
const pendingMonthPulls = new Map()

const WAIT_MS = 5000

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
 * @param {unknown} payload wire 载荷
 * @returns {object | null} 解析后的 want
 */
export function parseFedArchiveMonthWant(payload) {
	if (!isPlainObject(payload)) return null
	const groupId = String(payload.groupId || '').trim()
	const channelId = String(payload.channelId || '').trim()
	const utcMonth = String(payload.utcMonth || '').trim()
	const requestId = String(payload.requestId || '').trim()
	if (!groupId || !channelId || !/^\d{4}-\d{2}$/u.test(utcMonth) || !requestId) return null
	return {
		groupId,
		channelId,
		utcMonth,
		requestId,
		requesterNodeHash: String(payload.requesterNodeHash || '').trim(),
	}
}

/**
 * @param {unknown} payload wire 载荷
 * @returns {object | null} 解析后的 response
 */
export function parseFedArchiveMonthResponse(payload) {
	if (!isPlainObject(payload)) return null
	const requestId = String(payload.requestId || '').trim()
	const channelId = String(payload.channelId || '').trim()
	const utcMonth = String(payload.utcMonth || '').trim()
	if (!requestId || !channelId || !/^\d{4}-\d{2}$/u.test(utcMonth)) return null
	return {
		requestId,
		channelId,
		utcMonth,
		body: typeof payload.body === 'string' ? payload.body : '',
		seal: isPlainObject(payload.seal) ? payload.seal : null,
		complete: payload.complete !== false,
		reason: String(payload.reason || '').trim(),
	}
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
	const path = channelArchivePath(username, groupId, request.channelId, request.utcMonth)
	const manifest = await loadArchiveManifest(username, groupId)
	const seal = manifest.seals?.[request.channelId] || null
	let body = ''
	try {
		body = await readFile(path, 'utf8')
	}
	catch {
		sendResponse({
			requestId: request.requestId,
			channelId: request.channelId,
			utcMonth: request.utcMonth,
			complete: false,
			reason: 'missing',
			body: '',
			seal,
		}, peerId)
		return
	}
	sendResponse({
		requestId: request.requestId,
		channelId: request.channelId,
		utcMonth: request.utcMonth,
		complete: true,
		body,
		seal,
	}, peerId)
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} response 响应
 * @returns {Promise<{ applied: boolean }>} 是否写入磁盘
 */
export async function applyFedArchiveMonthResponse(username, groupId, response) {
	const key = monthPullWaitKey(username, groupId, response.requestId)
	const pending = pendingMonthPulls.get(key)
	if (pending) {
		clearTimeout(pending.timer)
		pendingMonthPulls.delete(key)
		pending.resolve(response)
	}
	if (!response.complete || !response.body) {
		await markArchiveMonthIncomplete(username, groupId, response.channelId, response.utcMonth, response.reason || 'pull_failed')
		return { applied: false }
	}
	const manifest = await loadArchiveManifest(username, groupId)
	if (response.seal) {
		const checkpoint = await safeReadJson(snapshotPath(username, groupId))
		const state = materializeFromCheckpoint(checkpoint)
		/** @type {string | null} */
		let ownerHex = null
		for (const member of Object.values(state.members || {})) 
			if (member?.role === 'owner' && isHex64(member.pubKeyHex)) {
				ownerHex = String(member.pubKeyHex).trim().toLowerCase()
				break
			}
		
		if (ownerHex) {
			const { Buffer } = await import('node:buffer')
			const ok = await verifyArchiveSeal(response.seal, new Uint8Array(Buffer.from(ownerHex, 'hex')))
			if (!ok) {
				await markArchiveMonthIncomplete(username, groupId, response.channelId, response.utcMonth, 'seal_invalid')
				return { applied: false }
			}
		}
	}
	const { writeFile, mkdir } = await import('node:fs/promises')
	const { dirname } = await import('node:path')
	const path = channelArchivePath(username, groupId, response.channelId, response.utcMonth)
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, response.body.endsWith('\n') ? response.body : `${response.body}\n`, 'utf8')
	if (!manifest.channels[response.channelId]) manifest.channels[response.channelId] = { months: [] }
	if (!manifest.channels[response.channelId].months.includes(response.utcMonth))
		manifest.channels[response.channelId].months.push(response.utcMonth)
	if (manifest.coverage?.[response.channelId]) delete manifest.coverage[response.channelId]
	manifest.archive_coverage_complete = Object.values(manifest.coverage || {})
		.every(row => row?.complete !== false)
	await saveArchiveManifest(username, groupId, manifest)
	return { applied: true }
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道
 * @param {string} utcMonth `YYYY-MM`
 * @param {string} reason 缺口原因
 * @returns {Promise<void>}
 */
export async function markArchiveMonthIncomplete(username, groupId, channelId, utcMonth, reason) {
	const manifest = await loadArchiveManifest(username, groupId)
	if (!manifest.coverage) manifest.coverage = {}
	manifest.coverage[channelId] = { complete: false, utcMonth, reason }
	manifest.archive_coverage_complete = false
	await saveArchiveManifest(username, groupId, manifest)
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} slot 联邦槽
 * @returns {Promise<{ pulled: number, incomplete: number }>} 拉取与缺口统计
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

	const nodeHash = federationNodeHash(username)
	const groupSettings = await loadFederationGroupSettings(username, groupId)
	const targets = await pickFederationTargetPeerIds(
		username,
		groupId,
		slot.getRoster(),
		groupSettings,
		nodeHash,
	)

	let pulled = 0
	let incomplete = 0
	for (const channelId of channels) {
		const path = channelArchivePath(username, groupId, channelId, utcMonth)
		try {
			await readFile(path, 'utf8')
			continue
		}
		catch { /* missing */ }

		const requestId = randomUUID()
		const request = {
			requestId,
			groupId,
			channelId,
			utcMonth,
			requesterNodeHash: nodeHash,
		}
		const responsePromise = new Promise(resolve => {
			const timer = setTimeout(() => {
				pendingMonthPulls.delete(monthPullWaitKey(username, groupId, requestId))
				resolve(null)
			}, WAIT_MS)
			pendingMonthPulls.set(monthPullWaitKey(username, groupId, requestId), { resolve, timer })
		})
		if (targets.length)
			for (const peerId of targets)
				slot.send('fed_archive_month_want', request, peerId)
		else
			slot.send('fed_archive_month_want', request, null)

		const response = await responsePromise
		if (response && (await applyFedArchiveMonthResponse(username, groupId, response)).applied)
			pulled++
		else {
			await markArchiveMonthIncomplete(username, groupId, channelId, utcMonth, 'timeout')
			incomplete++
		}
	}
	return { pulled, incomplete }
}
