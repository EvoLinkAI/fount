/**
 * 群级消息发送限速：按用户 pubKeyHash 与 agent charId 分别计数。
 */
import { memberChannelPermissions } from '../../../../../../../scripts/p2p/materialized_state.mjs'
import {
	messageRateEntityKey,
	resolveMessageRateLimits,
} from '../../../../../../../scripts/p2p/message_rate_limit.mjs'
import { PERMISSIONS } from '../../../../../../../scripts/p2p/permissions.mjs'
import { readJsonl } from '../dag/storage.mjs'
import { eventsPath } from '../lib/paths.mjs'

/**
 *
 */
export { messageRateEntityKey, resolveMessageRateLimits }

const TAIL_SCAN_MAX = 200

/**
 * @param {object} state 物化群状态
 * @param {string} senderPubKeyHash 事件 sender
 * @param {string} channelId 频道 ID
 * @returns {boolean} 是否可绕过限速
 */
export function hasBypassRateLimit(state, senderPubKeyHash, channelId) {
	const sender = String(senderPubKeyHash || '').trim().toLowerCase()
	if (!sender) return false
	const perms = memberChannelPermissions(state, sender, channelId)
	return !!perms[PERMISSIONS.BYPASS_RATE_LIMIT]
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object} state 物化状态
 * @param {object} event 待发送 message 事件
 * @returns {Promise<{ ok: boolean, reason?: string }>} 是否允许发送
 */
export async function checkMessageRateLimit(username, groupId, state, event) {
	if (event?.type !== 'message') return { ok: true }
	const entityKey = messageRateEntityKey(event)
	if (!entityKey) return { ok: false, reason: 'missing sender' }
	const channelId = event.channelId || event.content?.channelId || 'default'
	const senderHash = String(event.sender || '').trim().toLowerCase()
	if (hasBypassRateLimit(state, senderHash, channelId)) return { ok: true }

	const { perMin, windowMs } = resolveMessageRateLimits(state.groupSettings || {})
	const now = Date.now()
	const events = await readJsonl(eventsPath(username, groupId))
	const tail = events.slice(-TAIL_SCAN_MAX)
	let count = 0
	for (let i = tail.length - 1; i >= 0; i--) {
		const row = tail[i]
		if (row?.type !== 'message') continue
		if (messageRateEntityKey(row) !== entityKey) continue
		const wall = Number(row.hlc?.wall ?? row.timestamp ?? 0)
		if (now - wall > windowMs) break
		count++
		if (count >= perMin) return { ok: false, reason: 'message rate limit exceeded' }
	}
	return { ok: true }
}
