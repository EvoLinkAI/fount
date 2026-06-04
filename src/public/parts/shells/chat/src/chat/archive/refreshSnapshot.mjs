/**
 * 已冷归档消息的 PostSnapshot 刷新（message_edit 后）。
 */
import { writeFile } from 'node:fs/promises'

import { readJsonlStream } from '../../../../../../../scripts/p2p/dag/storage.mjs'
import { findChannelMessageRow } from '../channel/messageMutations.mjs'
import { getState } from '../dag/materialize.mjs'
import { channelArchivePath } from '../lib/paths.mjs'

import { isEventArchivedInManifest, loadArchiveManifest } from './index.mjs'
import { buildPostSnapshotsFromLines } from './postSnapshot.mjs'
import { sealArchiveChannelBatch } from './seal.mjs'

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {string} eventId message eventId
 * @returns {Promise<boolean>} 是否已更新归档行
 */
export async function refreshArchivedSnapshotIfPresent(username, groupId, channelId, eventId) {
	const id = String(eventId || '').trim().toLowerCase()
	if (!id) return false
	const manifest = await loadArchiveManifest(username, groupId)
	if (!isEventArchivedInManifest(manifest, channelId, id)) return false
	const month = manifest.archivedEventIds[channelId]?.[id]
	if (!month) return false

	const { state } = await getState(username, groupId)
	const row = await findChannelMessageRow(username, groupId, channelId, id)
	if (!row) return false
	const edited = state.messageOverlay?.editHistory?.get(id)
	if (edited) row.content = edited
	const snaps = await buildPostSnapshotsFromLines(username, groupId, channelId, [row], state)
	const snap = snaps[0]
	if (!snap) return false

	const path = channelArchivePath(username, groupId, channelId, month)
	/** @type {object[]} */
	const rows = []
	let replaced = false
	for await (const line of readJsonlStream(path)) 
		if (String(line.eventId).trim().toLowerCase() === id) {
			rows.push(snap)
			replaced = true
		}
		else rows.push(line)
	
	if (!replaced) return false
	await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n', 'utf8')
	const batchIds = Object.keys(manifest.archivedEventIds[channelId] || {})
	await sealArchiveChannelBatch(username, groupId, channelId, batchIds, id)
	return true
}
