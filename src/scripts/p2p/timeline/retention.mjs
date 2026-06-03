import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { topologicalCanonicalOrder } from '../dag/index.mjs'
import { readJsonl } from '../dag/storage.mjs'
import { invalidateTopologicalOrderMemo } from '../topo_order_memo.mjs'

/**
 * @param {string} eventsFilePath events.jsonl 路径
 * @param {object | null} checkpointHint 检查点提示
 * @param {{ maxDepth: number, maxMs: number, anchorTypes: Set<string> }} policy 保留策略
 * @param {(row: object) => object} sanitize 行规范化
 * @returns {Promise<{ pruned: boolean, kept: number, dropped: number }>} 裁剪统计
 */
export async function enforceTimelineEventRetention(
	eventsFilePath,
	checkpointHint,
	policy,
	sanitize = row => row,
) {
	const events = await readJsonl(eventsFilePath, { sanitize })
	if (!events.length) return { pruned: false, kept: 0, dropped: 0 }
	const maxDepth = Math.max(256, Number(policy.maxDepth) || 200_000)
	const maxMs = Math.max(3_600_000, Number(policy.maxMs) || 365 * 24 * 3600 * 1000)
	const cutoffWall = Date.now() - maxMs
	const order = topologicalCanonicalOrder(events.map(e => ({
		id: e.id,
		prev_event_ids: e.prev_event_ids,
		hlc: e.hlc,
		node_id: e.node_id,
		sender: e.sender,
	})))
	const byId = new Map(events.map(e => [e.id, e]))
	let anchorIdx = order.length
	for (let index = order.length - 1; index >= 0; index--) {
		const ev = byId.get(order[index])
		if (ev && policy.anchorTypes.has(ev.type)) anchorIdx = index
	}
	const depthStart = Math.max(0, order.length - maxDepth)
	let timeStart = 0
	for (let index = 0; index < order.length; index++) {
		const wall = Number(byId.get(order[index])?.hlc?.wall ?? 0)
		if (wall >= cutoffWall) {
			timeStart = index
			break
		}
	}
	const tipId = checkpointHint?.checkpoint_event_id
	let checkpointStart = 0
	if (tipId) {
		const tipIdx = order.indexOf(tipId)
		if (tipIdx >= 0) checkpointStart = tipIdx
	}
	const startIdx = Math.max(depthStart, timeStart, anchorIdx, checkpointStart)
	if (startIdx <= 0) return { pruned: false, kept: events.length, dropped: 0 }
	const kept = order.slice(startIdx).map(id => byId.get(id)).filter(Boolean)
	const dropped = events.length - kept.length
	if (dropped <= 0) return { pruned: false, kept: kept.length, dropped: 0 }
	await mkdir(dirname(eventsFilePath), { recursive: true })
	await writeFile(eventsFilePath, kept.map(JSON.stringify).join('\n') + (kept.length ? '\n' : ''), 'utf8')
	invalidateTopologicalOrderMemo(eventsFilePath)
	return { pruned: true, kept: kept.length, dropped }
}
