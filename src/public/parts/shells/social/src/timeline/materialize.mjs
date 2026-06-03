import { stat } from 'node:fs/promises'

import { createLruMap } from '../../../../../../scripts/memo.mjs'
import { writeJsonAtomicSynced } from '../../../../../../scripts/p2p/dag/storage.mjs'
import { parseEntityHash } from '../../../../../../scripts/p2p/entity_id.mjs'
import {
	createSocialTimelineState,
	finalizeSocialTimelineView,
	SOCIAL_TIMELINE_REDUCERS,
} from '../../../../../../scripts/p2p/reducers/social.mjs'
import { materializeFromEvents } from '../../../../../../scripts/p2p/timeline/materialize_runner.mjs'
import { timelineEventsPath, timelineSnapshotPath } from '../paths.mjs'

import { readTimelineEvents } from './append.mjs'

const TIMELINE_VIEW_CACHE_MAX = 256

/** @type {ReturnType<typeof createLruMap<Map<string, { mtime: number, size: number, view: object }>>>} */
const timelineViewCache = createLruMap(TIMELINE_VIEW_CACHE_MAX)

/**
 * @param {string} username 用户
 * @param {string} entityHash 时间线 owner
 * @returns {Map<string, { mtime: number, size: number, view: object }>} 该用户的 entity 物化缓存桶
 */
function timelineCacheBucket(username) {
	let bucket = timelineViewCache.get(username)
	if (!bucket) {
		bucket = new Map()
		timelineViewCache.touch(username, bucket)
	}
	return bucket
}

/**
 * 时间线 events 变更后失效内存物化缓存。
 * @param {string} username 用户
 * @param {string} entityHash 时间线 owner
 * @returns {void}
 */
export function invalidateTimelineMaterializedCache(username, entityHash) {
	const target = String(entityHash).toLowerCase()
	const inner = timelineViewCache.get(username)
	if (!inner) return
	inner.delete(target)
	if (!inner.size) timelineViewCache.delete(username)
}

/**
 * 将原始时间线事件物化为 reducer 视图。
 * @param {object[]} events 原始事件
 * @returns {object} 物化视图
 */
export function materializeTimeline(events) {
	const { state, order } = materializeFromEvents(events, SOCIAL_TIMELINE_REDUCERS, createSocialTimelineState)
	return finalizeSocialTimelineView(state, order)
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

/**
 * @param {object | null} cached 磁盘快照
 * @param {import('node:fs').Stats} fileStat events.jsonl stat
 * @returns {boolean} 快照是否与 events 文件一致
 */
function snapshotMatchesEventsFile(cached, fileStat) {
	return cached?.events_mtime === fileStat.mtimeMs
		&& cached?.events_size === fileStat.size
}

/**
 * 读取并物化时间线；events.jsonl 未变则命中 snapshot（先 stat，避免全量 JSONL parse）。
 * @param {string} username 用户
 * @param {string} entityHash 时间线 owner
 * @returns {Promise<object>} 物化视图
 */
export async function getTimelineMaterialized(username, entityHash) {
	if (!parseEntityHash(entityHash)) throw new Error('invalid entityHash')
	const eventsPath = timelineEventsPath(username, entityHash)
	const entityKey = String(entityHash).toLowerCase()
	/** @type {import('node:fs').Stats | null} */
	let fileStat = null
	try {
		fileStat = await stat(eventsPath)
	}
	catch {
		invalidateTimelineMaterializedCache(username, entityHash)
		return materializeTimeline([])
	}

	const bucket = timelineCacheBucket(username)
	const memoryHit = bucket.get(entityKey)
	if (memoryHit?.mtime === fileStat.mtimeMs && memoryHit?.size === fileStat.size)
		return memoryHit.view

	const cached = await loadTimelineSnapshot(username, entityHash)
	if (snapshotMatchesEventsFile(cached, fileStat)) {
		const entry = { mtime: fileStat.mtimeMs, size: fileStat.size, view: cached }
		bucket.set(entityKey, entry)
		timelineViewCache.touch(username, bucket)
		return entry.view
	}

	const events = await readTimelineEvents(username, entityHash)
	const tipId = events.length ? events[events.length - 1].id : null
	const view = materializeTimeline(events)
	const snapshot = {
		entityHash: entityHash.toLowerCase(),
		checkpoint_event_id: tipId,
		events_mtime: fileStat.mtimeMs,
		events_size: fileStat.size,
		materializedAt: Date.now(),
		...view,
	}
	await writeJsonAtomicSynced(timelineSnapshotPath(username, entityHash), snapshot)
	bucket.set(entityKey, {
		mtime: fileStat.mtimeMs,
		size: fileStat.size,
		view: snapshot,
	})
	timelineViewCache.touch(username, bucket)
	return view
}
