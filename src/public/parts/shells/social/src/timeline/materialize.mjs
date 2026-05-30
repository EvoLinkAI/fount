import { topologicalCanonicalOrder } from '../../../../../../scripts/p2p/dag/index.mjs'
import { writeJsonAtomicSynced } from '../../../../../../scripts/p2p/dag/storage.mjs'
import { parseEntityHash } from '../../../../../../scripts/p2p/entity_id.mjs'
import {
	createSocialTimelineState,
	finalizeSocialTimelineView,
	SOCIAL_TIMELINE_REDUCERS,
} from '../../../../../../scripts/p2p/reducers/social.mjs'
import { materializeFromEvents } from '../../../../../../scripts/p2p/timeline/materialize_runner.mjs'
import { timelineSnapshotPath } from '../paths.mjs'

import { readTimelineEvents } from './append.mjs'


/**
 * 将原始时间线事件物化为 reducer 视图。
 * @param {object[]} events 原始事件
 * @returns {object} 物化视图
 */
export function materializeTimeline(events) {
	const order = topologicalCanonicalOrder(events.map(event => ({
		id: event.id,
		prev_event_ids: event.prev_event_ids,
		hlc: event.hlc,
		node_id: event.node_id,
	})))
	const raw = materializeFromEvents(events, SOCIAL_TIMELINE_REDUCERS, createSocialTimelineState)
	return finalizeSocialTimelineView(raw, order)
}

/**
 * 读取并物化时间线，同时写入快照缓存。
 * @param {string} username 用户
 * @param {string} entityHash 时间线 owner
 * @returns {Promise<object>} 物化视图
 */
export async function getTimelineMaterialized(username, entityHash) {
	if (!parseEntityHash(entityHash)) throw new Error('invalid entityHash')
	const events = await readTimelineEvents(username, entityHash)
	const view = materializeTimeline(events)
	await writeJsonAtomicSynced(timelineSnapshotPath(username, entityHash), {
		entityHash: entityHash.toLowerCase(),
		materializedAt: Date.now(),
		...view,
	})
	return view
}

/**
 * 读取磁盘上的物化快照（不重新计算）。
 * @param {string} username 用户
 * @param {string} entityHash 时间线 owner
 * @returns {Promise<object | null>} 缓存快照
 */
export async function loadTimelineSnapshot(username, entityHash) {
	try {
		const { readFile } = await import('node:fs/promises')
		return JSON.parse(await readFile(timelineSnapshotPath(username, entityHash), 'utf8'))
	}
	catch {
		return null
	}
}
