import { loadLatestChannelKeyWrapsForRecipient } from './wrapsFromEvents.mjs'

/**
 * 从 DAG 收集各频道最新 wrap（入群/补拉用；不读 checkpoint 内全员 wraps）。
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} recipientPubKeyHash 64 hex
 * @returns {Promise<Record<string, { generation: number, wrap: object }>>} channelId → wrap 载荷
 */
export async function collectChannelKeyWrapsForRecipient(username, groupId, recipientPubKeyHash) {
	return loadLatestChannelKeyWrapsForRecipient(username, groupId, recipientPubKeyHash)
}
