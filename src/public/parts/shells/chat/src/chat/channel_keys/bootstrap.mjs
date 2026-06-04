import { normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { getState } from '../dag/materialize.mjs'

/**
 * 从物化状态收集各频道最新 wrap（入群/补拉用）。
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} recipientPubKeyHash 64 hex
 * @returns {Promise<Record<string, { generation: number, wrap: object }>>} channelId → wrap 载荷
 */
export async function collectChannelKeyWrapsForRecipient(username, groupId, recipientPubKeyHash) {
	const recipient = normalizeHex64(recipientPubKeyHash)
	if (!recipient) return {}
	const { state } = await getState(username, groupId)
	/** @type {Record<string, { generation: number, wrap: object }>} */
	const out = {}
	for (const [channelId, row] of Object.entries(state.channelKeyWraps || {})) {
		const wrap = row?.wraps?.[recipient]
		if (!wrap) continue
		out[channelId] = { generation: row.generation, wrap }
	}
	return out
}
