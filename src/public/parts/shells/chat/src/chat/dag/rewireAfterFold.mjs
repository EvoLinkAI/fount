/**
 * fold 后把悬空 prev_event_ids 改接到 checkpoint 尖。
 */
import { sortedPrevEventIds } from '../../../../../../scripts/p2p/dag/index.mjs'
import { readJsonlStream, rewriteJsonlKeeping } from '../../../../../../scripts/p2p/dag/storage.mjs'
import { invalidateTopologicalOrderMemo } from '../../../../../../scripts/p2p/topo_order_memo.mjs'
import { sanitizeFederatedEvent } from '../events/wire.mjs'
import { eventsPath } from '../lib/paths.mjs'

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} checkpointTipId checkpoint_event_id
 * @returns {Promise<{ rewired: number }>} 改写条数统计
 */
export async function rewireDagPrevToCheckpointTip(username, groupId, checkpointTipId) {
	const tip = String(checkpointTipId || '').trim().toLowerCase()
	if (!tip) return { rewired: 0 }
	const path = eventsPath(username, groupId)
	/** @type {Set<string>} */
	const keptIds = new Set()
	for await (const row of readJsonlStream(path, { sanitize: sanitizeFederatedEvent })) 
		if (row?.id) keptIds.add(String(row.id).trim().toLowerCase())
	
	if (!keptIds.size) return { rewired: 0 }

	let rewired = 0
	await rewriteJsonlKeeping(path, row => {
		if (!row?.id) return false
		const parents = sortedPrevEventIds(row.prev_event_ids)
		if (!parents.length) return true
		let changed = false
		const next = []
		for (const parentId of parents) 
			if (keptIds.has(parentId)) next.push(parentId)
			else changed = true
		
		if (changed) {
			rewired++
			if (!next.includes(tip)) next.push(tip)
			row.prev_event_ids = sortedPrevEventIds(next)
		}
		return true
	}, { sanitize: sanitizeFederatedEvent })

	invalidateTopologicalOrderMemo(`${username}:${groupId}`)
	return { rewired }
}
