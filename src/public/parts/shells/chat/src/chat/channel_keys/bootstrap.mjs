import { normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { getState } from '../dag/materialize.mjs'

/**
 * 从物化状态收集各频道最新 wrap（入群/补拉用，避免扫描 events.jsonl）。
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} recipientPubKeyHash 64 hex
 * @returns {Promise<object[]>} 合成 channel_key_rotate 事件列表
 */
export async function collectChannelKeyRotatesForRecipient(username, groupId, recipientPubKeyHash) {
	const recipient = normalizeHex64(recipientPubKeyHash)
	if (!recipient) return []
	const { state } = await getState(username, groupId)
	/** @type {object[]} */
	const rotates = []
	for (const [channelId, row] of Object.entries(state.channelKeyWraps || {})) {
		const wrap = row?.wraps?.[recipient]
		if (!wrap) continue
		rotates.push({
			type: 'channel_key_rotate',
			content: {
				channelId,
				generation: row.generation,
				wraps: { [recipient]: wrap },
			},
		})
	}
	return rotates
}
