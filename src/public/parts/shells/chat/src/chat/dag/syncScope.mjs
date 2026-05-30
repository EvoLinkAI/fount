/**
 * 【文件】`dag/syncScope.mjs` — DAG 节点 id 与频道同步范围过滤。
 * 【职责】导出本进程 `NODE_ID`；判定 `syncScope:channel` 下哪些事件纳入频道增量同步切片。
 * 【原理】`NODE_ID` 写入事件的 `node_id` 标识来源节点；懒同步仅透传目标频道相关的消息类事件，`list_item_update` 按 `content.channelId` 匹配。
 * 【数据结构】`CHANNEL_SYNC_MESSAGE_TYPES` 为可过滤的消息相关 type 集合；`effectiveEventChannelIdForSync` 归一化频道 id。
 * 【关联】`append.mjs`、`queries.mjs`、`sessionEventValidate.mjs`。
 */
import { randomUUID } from 'node:crypto'

import { resolveChannelId } from '../lib/channelId.mjs'

/** 懒同步频道时视为「频道内载荷」的事件（其余类型在 `syncScope:channel` 下默认全量透传）。 */
const CHANNEL_SYNC_MESSAGE_TYPES = new Set([
	'message',
	'message_edit',
	'message_delete',
	'message_feedback',
	'vote_cast',
	'reaction_add',
	'reaction_remove',
	'pin_message',
	'unpin_message',
])

/** 本进程 DAG 节点的随机 UUID，用于写入事件的 `node_id` 字段。 */
export const NODE_ID = randomUUID()

/**
 * @param {object} event DAG 事件
 * @returns {string} 归一化频道 id（缺省为 `default`）
 */
function effectiveEventChannelIdForSync(event) {
	return resolveChannelId(event.channelId, resolveChannelId(event.content.channelId))
}

/**
 * `syncScope:'channel'` 下是否应将该事件纳入对该频道的增量同步切片。
 * @param {object} event 事件
 * @param {string} channelId 目标频道
 * @returns {boolean} 是否纳入懒同步切片
 */
export function eventMatchesLazyChannelScope(event, channelId) {
	const eventType = event.type
	if (!CHANNEL_SYNC_MESSAGE_TYPES.has(eventType)) {
		if (eventType === 'list_item_update')
			return (event?.content?.channelId?.trim() || '') === channelId
		return false
	}
	return effectiveEventChannelIdForSync(event) === channelId
}

