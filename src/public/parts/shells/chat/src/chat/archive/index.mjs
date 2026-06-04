import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { writeJsonAtomicSynced } from '../../../../../../../scripts/p2p/dag/storage.mjs'
import { archiveManifestPath, channelArchivePath } from '../lib/paths.mjs'

import { archiveMonthKey } from './settings.mjs'

/**
 * @param {object | null} raw 磁盘 manifest
 * @returns {object} 规范化 manifest
 */
function normalizeManifest(raw) {
	const coverage = raw?.coverage && typeof raw.coverage === 'object' ? raw.coverage : {}
	const seals = raw?.seals && typeof raw.seals === 'object' ? raw.seals : {}
	const monthDigests = raw?.monthDigests && typeof raw.monthDigests === 'object' ? raw.monthDigests : {}
	return {
		version: 1,
		monthBucketPolicy: 'UTC',
		channels: raw?.channels && typeof raw.channels === 'object' ? raw.channels : {},
		archivedEventIds: raw?.archivedEventIds && typeof raw.archivedEventIds === 'object'
			? raw.archivedEventIds
			: {},
		seals,
		monthDigests,
		coverage,
		archive_coverage_complete: raw?.archive_coverage_complete !== false,
	}
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @returns {Promise<object>} manifest
 */
export async function loadArchiveManifest(username, groupId) {
	try {
		return normalizeManifest(JSON.parse(await readFile(archiveManifestPath(username, groupId), 'utf8')))
	}
	catch {
		return normalizeManifest(null)
	}
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} manifest manifest
 * @returns {Promise<void>} 无返回值
 */
export async function saveArchiveManifest(username, groupId, manifest) {
	await writeJsonAtomicSynced(archiveManifestPath(username, groupId), normalizeManifest(manifest))
}

/**
 * @param {object} manifest manifest
 * @param {string} channelId 频道 ID
 * @param {string} eventId 事件 id
 * @returns {boolean} 是否已归档
 */
export function isEventArchivedInManifest(manifest, channelId, eventId) {
	const ch = manifest.archivedEventIds?.[channelId]
	return ch ? Object.prototype.hasOwnProperty.call(ch, eventId) : false
}

/**
 * @param {object} manifest archive manifest
 * @returns {Set<string>} 已归档 message eventId
 */
export function archivedMessageIdSet(manifest) {
	const set = new Set()
	for (const ch of Object.values(manifest.archivedEventIds || {}))
		for (const eventId of Object.keys(ch)) set.add(eventId)
	return set
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {object[]} snapshots PostSnapshot 列表
 * @returns {Promise<number>} 新写入条数
 */
export async function appendPostSnapshotsToArchive(username, groupId, channelId, snapshots) {
	if (!snapshots?.length) return 0
	const manifest = await loadArchiveManifest(username, groupId)
	if (!manifest.archivedEventIds[channelId]) manifest.archivedEventIds[channelId] = {}
	if (!manifest.channels[channelId]) manifest.channels[channelId] = { months: [] }
	const chMeta = manifest.channels[channelId]
	/** @type {Map<string, object[]>} */
	const byMonth = new Map()
	let added = 0
	for (const snap of snapshots) {
		const eventId = String(snap.eventId).trim()
		if (!eventId || isEventArchivedInManifest(manifest, channelId, eventId)) continue
		const wall = Number(snap.hlc?.wall ?? snap.timestamp ?? Date.now())
		const month = archiveMonthKey(wall)
		if (!byMonth.has(month)) byMonth.set(month, [])
		byMonth.get(month).push(snap)
		manifest.archivedEventIds[channelId][eventId] = month
		added++
		if (!chMeta.months.includes(month)) chMeta.months.push(month)
	}
	for (const [month, rows] of byMonth) {
		const path = channelArchivePath(username, groupId, channelId, month)
		await mkdir(dirname(path), { recursive: true })
		const block = rows.map(JSON.stringify).join('\n') + '\n'
		await appendFile(path, block, 'utf8')
		const { refreshManifestMonthDigest } = await import('./monthDigest.mjs')
		await refreshManifestMonthDigest(username, groupId, channelId, month, manifest)
	}
	if (added) await saveArchiveManifest(username, groupId, manifest)
	return added
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @returns {Promise<Array<{ channelId: string, month: string, path: string }>>} 归档文件列表
 */
export async function listArchiveFiles(username, groupId) {
	const manifest = await loadArchiveManifest(username, groupId)
	/** @type {Array<{ channelId: string, month: string, path: string }>} */
	const out = []
	for (const [channelId, meta] of Object.entries(manifest.channels || {})) 
		for (const month of meta.months || [])
			out.push({
				channelId,
				month,
				path: channelArchivePath(username, groupId, channelId, month),
			})
	
	return out
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} beforeMonth 删除此月之前（不含）的归档，`YYYY-MM`
 * @returns {Promise<{ deletedFiles: number, droppedIds: number }>} 统计
 */
export async function deleteArchivesBeforeMonth(username, groupId, beforeMonth) {
	const manifest = await loadArchiveManifest(username, groupId)
	const { unlink } = await import('node:fs/promises')
	let deletedFiles = 0
	let droppedIds = 0
	for (const [channelId, meta] of Object.entries(manifest.channels || {})) {
		const keepMonths = (meta.months || []).filter(m => m >= beforeMonth)
		const dropMonths = new Set((meta.months || []).filter(m => m < beforeMonth))
		for (const month of dropMonths) 
			try {
				await unlink(channelArchivePath(username, groupId, channelId, month))
				deletedFiles++
			}
			catch { /* missing */ }
		
		meta.months = keepMonths.sort()
		const idMap = manifest.archivedEventIds[channelId] || {}
		for (const [eventId, month] of Object.entries(idMap)) 
			if (dropMonths.has(month)) {
				delete idMap[eventId]
				droppedIds++
			}
		
	}
	await saveArchiveManifest(username, groupId, manifest)
	return { deletedFiles, droppedIds }
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @returns {Promise<Array<{ channelId: string, month: string, bytes: number }>>} 各文件大小
 */
export async function summarizeArchiveStorage(username, groupId) {
	const { stat } = await import('node:fs/promises')
	const files = await listArchiveFiles(username, groupId)
	const out = []
	for (const row of files) 
		try {
			const st = await stat(row.path)
			out.push({ channelId: row.channelId, month: row.month, bytes: st.size })
		}
		catch { /* gone */ }
	
	return out
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @returns {Promise<string[]>} 已有月份列表
 */
export async function listArchiveMonthsForChannel(username, groupId, channelId) {
	const manifest = await loadArchiveManifest(username, groupId)
	return [...manifest.channels?.[channelId]?.months || []].sort()
}
