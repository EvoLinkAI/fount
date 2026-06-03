/**
 * DAG 过程事件折叠：删除可折叠类型；已归档 message 可选删除。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { readJsonl } from '../../../../../../../scripts/p2p/dag/storage.mjs'
import { invalidateTopologicalOrderMemo } from '../../../../../../../scripts/p2p/topo_order_memo.mjs'
import { allProtectedHotEventIds } from '../archive/hotPosts.mjs'
import { archivedMessageIdSet, loadArchiveManifest } from '../archive/index.mjs'
import { archiveSettingsFromGroup } from '../archive/settings.mjs'
import { sanitizeFederatedEvent } from '../events/wire.mjs'
import { eventsPath } from '../lib/paths.mjs'

/**
 *
 */
export { FOLDABLE_PROCESS_EVENT_TYPES, shouldDropDagEvent } from './foldPolicy.mjs'

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} hotPosts hot_posts
 * @param {object} groupSettings 群设置
 * @returns {Promise<{ dropped: number, kept: number }>} 统计
 */
export async function foldDagProcessEvents(username, groupId, hotPosts, groupSettings = {}) {
	const { shouldDropDagEvent: shouldDrop } = await import('./foldPolicy.mjs')
	const settings = archiveSettingsFromGroup(groupSettings)
	const manifest = await loadArchiveManifest(username, groupId)
	const archivedIds = archivedMessageIdSet(manifest)
	const protectedHotIds = allProtectedHotEventIds(hotPosts)
	const path = eventsPath(username, groupId)
	const events = await readJsonl(path, { sanitize: sanitizeFederatedEvent })
	if (!events.length) return { dropped: 0, kept: 0 }
	const kept = events.filter(ev => !shouldDrop(
		ev,
		archivedIds,
		protectedHotIds,
		settings.dagFoldAfterArchive,
	))
	const dropped = events.length - kept.length
	if (dropped <= 0) return { dropped: 0, kept: kept.length }
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, kept.map(JSON.stringify).join('\n') + (kept.length ? '\n' : ''), 'utf8')
	invalidateTopologicalOrderMemo(`${username}:${groupId}`)
	return { dropped, kept: kept.length }
}
