import { readJsonl } from '../../../../../../../scripts/p2p/dag/storage.mjs'
import { normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { eventsPath } from '../lib/paths.mjs'

/**
 * 收集各频道最新一条含收件人 wrap 的 channel_key_rotate（入群/补拉用）。
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} recipientPubKeyHash 64 hex
 * @returns {Promise<object[]>} channel_key_rotate 事件列表
 */
export async function collectChannelKeyRotatesForRecipient(username, groupId, recipientPubKeyHash) {
	const recipient = normalizeHex64(recipientPubKeyHash)
	if (!recipient) return []
	const events = await readJsonl(eventsPath(username, groupId))
	/** @type {Map<string, object>} */
	const latest = new Map()
	for (const event of events) {
		if (event.type !== 'channel_key_rotate') continue
		const channelId = String(event.content?.channelId || '').trim()
		const wraps = event.content?.wraps
		if (!channelId || !wraps?.[recipient]) continue
		const generation = Number(event.content?.generation)
		const prev = latest.get(channelId)
		if (!prev || generation >= Number(prev.content?.generation)) latest.set(channelId, event)
	}
	return [...latest.values()]
}
