import { createHash } from 'node:crypto'

import { canonicalStringify } from '../../../../../../../scripts/p2p/canonical_json.mjs'
import { computeLocalTipsHash, computeDagTipIdsFromEvents } from '../../../../../../../scripts/p2p/dag/index.mjs'
import { readJsonl } from '../../../../../../../scripts/p2p/dag/storage.mjs'
import { eventsPath } from '../lib/paths.mjs'

import { appendSignedLocalEvent } from './append.mjs'

/**
 * @param {object} state 物化状态
 * @param {string} anchorEventId checkpoint tip 事件 id
 * @param {object[]} [events] 全量事件（算 tipsHash）
 * @returns {object} state_summary content
 */
export function buildStateSummaryContent(state, anchorEventId, events = []) {
	const tipIds = computeDagTipIdsFromEvents(events)
	return {
		anchorEventId,
		membersRoot: state.membersRoot ?? null,
		channelPermissionsHash: createHash('sha256')
			.update(canonicalStringify(state.channelPermissions || {}))
			.digest('hex'),
		tipsHash: computeLocalTipsHash(tipIds),
		materializedAt: Date.now(),
	}
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} state 物化状态
 * @param {string} anchorEventId checkpoint tip
 * @returns {Promise<object | null>} 新签名事件或 null
 */
export async function maybeAppendStateSummary(username, groupId, state, anchorEventId) {
	const events = await readJsonl(eventsPath(username, groupId))
	const lastSummary = [...events].reverse().find(e => e.type === 'state_summary')
	const minInterval = 50_000
	if (lastSummary && events.length - events.indexOf(lastSummary) < minInterval) return null
	const content = buildStateSummaryContent(state, anchorEventId, events)
	return appendSignedLocalEvent(username, groupId, {
		type: 'state_summary',
		timestamp: Date.now(),
		content,
	})
}
