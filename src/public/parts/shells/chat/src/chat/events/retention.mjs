/**
 * 【文件】`events/retention.mjs` — DAG 事件流保留与裁剪（§7.1）。
 * 【职责】按群设置的深度与时间窗口裁剪 `events.jsonl`，同时保留权限锚点事件与 checkpoint tip 可达后缀。
 * 【原理】在拓扑序上计算 `retentionStartIndex`：不早于时间 cutoff、不裁掉 checkpoint 之前必要链、不裁断 `PERMISSION_ANCHOR_TYPES` 锚点；`materialize` 重建 checkpoint 后调用。
 * 【数据结构】`retentionStartIndex(order, byId, { maxDepth, cutoffWall, checkpointTipId? })` 纯函数；`enforceEventRetention` 返回 `{ pruned, kept, dropped }`。
 * 【关联】`materialize.mjs`、`queries.mjs`、`dag/storage.mjs`。
 */
/**
 * §7.1：按 `event_retention_depth` / `event_retention_ms` 裁剪 `events.jsonl`，并保留权限锚点后缀。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { topologicalCanonicalOrder } from '../../../../../../../scripts/p2p/dag/index.mjs'
import { retentionStartIndex } from '../../../../../../../scripts/p2p/retention_policy.mjs'
import { invalidateTopologicalOrderMemo } from '../../../../../../../scripts/p2p/topo_order_memo.mjs'
import { readJsonl } from '../dag/storage.mjs'
import { eventsPath, snapshotPath } from '../lib/paths.mjs'

/**
 * 计算事件保留裁剪起点索引（自 `p2p/retention_policy` 再导出）。
 */
export { retentionStartIndex }

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object | null} checkpoint 快照
 * @returns {Promise<object | null>} 检查点对象
 */
async function readCheckpoint(username, groupId, checkpoint) {
	if (checkpoint) return checkpoint
	try {
		return JSON.parse(await readFile(snapshotPath(username, groupId), 'utf8'))
	}
	catch {
		return null
	}
}

/**
 * 应用群设置中的事件保留窗口；在 `rebuildAndSaveCheckpoint` 之后调用。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object | null} [checkpointHint] 刚写入的检查点
 * @param {{ event_retention_depth?: unknown, event_retention_ms?: unknown }} [groupSettings] 群设置
 * @returns {Promise<{ pruned: boolean, kept: number, dropped: number }>} 裁剪统计
 */
export async function enforceEventRetention(username, groupId, checkpointHint = null, groupSettings = {}) {
	const eventsFilePath = eventsPath(username, groupId)
	const events = await readJsonl(eventsFilePath)
	if (!events.length) return { pruned: false, kept: 0, dropped: 0 }

	const maxDepth = Math.max(256, Number(groupSettings.event_retention_depth) || 200_000)
	const maxMs = Math.max(3_600_000, Number(groupSettings.event_retention_ms) || 365 * 24 * 3600 * 1000)
	const cutoffWall = Date.now() - maxMs

	const order = topologicalCanonicalOrder(events.map(e => ({
		id: e.id,
		prev_event_ids: e.prev_event_ids,
		hlc: e.hlc,
		node_id: e.node_id,
		sender: e.sender,
	})))
	const byId = new Map(events.map(e => [e.id, e]))

	const checkpoint = await readCheckpoint(username, groupId, checkpointHint)
	const tipId = checkpoint?.checkpoint_event_id
	const startIdx = retentionStartIndex(order, byId, {
		maxDepth,
		cutoffWall,
		checkpointTipId: String(tipId || '').trim() || undefined,
	})

	if (startIdx <= 0) return { pruned: false, kept: events.length, dropped: 0 }

	const kept = order.slice(startIdx).map(id => byId.get(id)).filter(Boolean)
	const dropped = events.length - kept.length
	if (dropped <= 0) return { pruned: false, kept: kept.length, dropped: 0 }

	await mkdir(dirname(eventsFilePath), { recursive: true })
	await writeFile(
		eventsFilePath,
		kept.map(JSON.stringify).join('\n') + (kept.length ? '\n' : ''),
		'utf8',
	)
	invalidateTopologicalOrderMemo(`${username}:${groupId}`)
	return { pruned: true, kept: kept.length, dropped }
}
