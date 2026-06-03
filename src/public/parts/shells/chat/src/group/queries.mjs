/**
 * 【文件】group/queries.mjs
 * 【职责】群侧栏列表、频道消息读取与 reaction 事件查询，为 HTTP/Hub 提供聚合读模型。
 * 【原理】遍历 userGroups 物化 state 过滤本机活跃成员；读 messages.jsonl 后 merge、解密、分页并解析 content_ref；为查看者附加 isRemote/authorPubKeyHash。
 * 【数据结构】群列表行、消息行（eventId/content/charId）、reaction 精简事件、分页参数 since/before/limit。
 * 【关联】被 group/routes/groups.mjs、channels.mjs 调用；依赖 chat/dag、chat/gsh、messageMerge、access.mjs。
 */
import { DEFAULT_STREAM_GENERATING_IDLE_MS } from '../../../../../../scripts/p2p/constants.mjs'
import { readJsonl } from '../../../../../../scripts/p2p/dag/storage.mjs'
import { getState } from '../chat/dag/materialize.mjs'
import { computeLastGroupActivityMs } from '../chat/dag/queries.mjs'
import { sanitizeFederatedEvent } from '../chat/events/wire.mjs'
import { resolveContentRefsInMessageLines } from '../chat/files/contentRefResolve.mjs'
import { mergeChannelMessagesForDisplay } from '../chat/lib/messageMerge.mjs'
import { eventsPath, snapshotPath } from '../chat/lib/paths.mjs'
import { listUserGroups } from '../chat/lib/userGroups.mjs'
import { safeReadJson } from '../chat/lib/utils.mjs'

import { resolveActiveMemberKeyForLocalUser } from './access.mjs'

/**
 * 为频道消息行附加 §17 展示字段：`isRemote`、`authorPubKeyHash`。
 * @param {object[]} lines 解密后的消息行
 * @param {string} viewerPubKeyHash 当前查看者成员键
 * @returns {object[]} 带展示元数据的消息行
 */
function enrichChannelMessagesForViewer(lines, viewerPubKeyHash) {
	const localMemberKey = viewerPubKeyHash.trim().toLowerCase()
	return lines.map(line => {
		const authorPubKeyHash = line.sender.trim().toLowerCase()
		return {
			...line,
			charId: line.charId || null,
			charOwner: line.content?.charOwner || null,
			authorPubKeyHash,
			isRemote: !!(authorPubKeyHash && authorPubKeyHash !== localMemberKey),
		}
	})
}

/**
 * 占位 `message` 超时未收到 `message_edit` 终稿时标记失败（§6.4）。
 * @param {object[]} lines 消息行（时间顺序）
 * @param {number} [idleMs] `streamGeneratingIdleMs` 阈值
 * @returns {object[]} 带 `streamGenerationFailed` 标记的副本
 */
function markStaleGeneratingMessages(lines, idleMs = DEFAULT_STREAM_GENERATING_IDLE_MS) {
	if (!lines.length) return lines
	const now = Date.now()
	const thresholdMs = idleMs > 0 ? idleMs : DEFAULT_STREAM_GENERATING_IDLE_MS
	return lines.map(line => {
		if (line.type !== 'message' || !line.content?.is_generating) return line
		if (line.timestamp && now - line.timestamp > thresholdMs)
			return { ...line, content: { ...line.content, is_generating: false, streamGenerationFailed: true } }
		return line
	})
}

/**
 * @param {string} username 用户名
 * @returns {Promise<object[]>} 群列表行
 */
export async function enumerateJoinedFederatedGroups(username) {
	const rows = []
	for (const groupId of await listUserGroups(username)) {
		const { state } = await getState(username, groupId)
		if (!await resolveActiveMemberKeyForLocalUser(username, groupId, state)) continue
		rows.push({
			groupId,
			name: state.groupMeta?.name || groupId,
			description: state.groupMeta?.description ?? '',
			avatar: state.groupMeta?.avatar ?? null,
			defaultChannelId: state.groupSettings?.defaultChannelId ?? null,
			memberCount: Object.values(state.members).filter(member => member?.status === 'active').length,
			channelCount: Object.keys(state.channels).length,
			lastMessageTime: await computeLastGroupActivityMs(username, groupId),
			friendBinding: state.groupMeta?.friendBinding || null,
		})
	}

	return rows
}

/**
 * 频道内 `reaction_add` / `reaction_remove` 事件（供 Hub 重放计票；仅存 events.jsonl）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @returns {Promise<object[]>} 精简 reaction 行
 */
export async function readChannelReactionEvents(username, groupId, channelId) {
	const events = await readJsonl(eventsPath(username, groupId), { sanitize: sanitizeFederatedEvent })
	return events
		.filter(event => ['reaction_add', 'reaction_remove'].includes(event.type) && (event.channelId || 'default') === channelId)
		.map(event => ({
			type: event.type,
			sender: event.sender,
			content: event.content,
			eventId: event.id,
			timestamp: event.hlc?.wall,
		}))
}

/**
 * 解密、合并、解析引用并为查看者附加展示字段。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object} state 物化状态
 * @param {object[]} lines 原始消息行
 * @returns {Promise<object[]>}  enriched 消息行
 */
async function finalizeChannelMessagesForViewer(username, groupId, state, lines) {
	const viewerPubKeyHash = await resolveActiveMemberKeyForLocalUser(username, groupId, state)
	if (!viewerPubKeyHash) throw new Error('Not a member')
	const streamGeneratingIdleMs = Number(state.groupSettings?.streamGeneratingIdleMs)
	return enrichChannelMessagesForViewer(
		await resolveContentRefsInMessageLines(username, markStaleGeneratingMessages(
			lines,
			Number.isFinite(streamGeneratingIdleMs) && streamGeneratingIdleMs > 0 ? streamGeneratingIdleMs : undefined,
		)),
		viewerPubKeyHash,
	)
}

/**
 * 读取频道消息 JSONL、解密、折叠 append 链并解析 content_ref。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {{ since?: string, before?: string, limit?: string | number, eventIds?: string[] }} [pagination] 分页参数
 * @returns {Promise<object[]>} 消息行对象数组
 */
export async function readChannelMessagesForUser(username, groupId, channelId, pagination = {}) {
	const { state } = await getState(username, groupId)
	const { listChannelMessages } = await import('../chat/dag/queries.mjs')
	const messageLimit = pagination.limit != null ? Number(pagination.limit) : undefined
	const limit = Number.isFinite(messageLimit) && messageLimit > 0 ? messageLimit : 50_000

	if (Array.isArray(pagination.eventIds) && pagination.eventIds.length) {
		let lines = await listChannelMessages(username, groupId, channelId, {
			includeArchive: true,
			decrypt: true,
			eventIds: pagination.eventIds,
			fetchFromPeers: true,
			limitCap: 50_000,
			limit: 50_000,
		})
		if (lines.length < pagination.eventIds.length) {
			const { requestChannelHistoryFromPeers } = await import('../chat/federation/channelHistory.mjs')
			await requestChannelHistoryFromPeers(username, groupId, channelId, { limit: 500 })
			lines = await listChannelMessages(username, groupId, channelId, {
				includeArchive: true,
				decrypt: true,
				eventIds: pagination.eventIds,
				fetchFromPeers: false,
				limitCap: 50_000,
				limit: 50_000,
			})
		}
		lines = mergeChannelMessagesForDisplay(lines)
		return finalizeChannelMessagesForViewer(username, groupId, state, lines)
	}

	let lines
	if (pagination.before && !pagination.since) {
		lines = await listChannelMessages(username, groupId, channelId, {
			includeArchive: true,
			decrypt: true,
			before: pagination.before,
			limit,
			fetchFromPeers: true,
		})
		lines = mergeChannelMessagesForDisplay(lines)
		return finalizeChannelMessagesForViewer(username, groupId, state, lines)
	}

	lines = await listChannelMessages(username, groupId, channelId, {
		includeArchive: true,
		decrypt: true,
		limitCap: 50_000,
		limit: 50_000,
	})
	lines = mergeChannelMessagesForDisplay(lines)
	if (pagination.since) {
		const sinceIndex = lines.findIndex(message => message.eventId === pagination.since)
		if (sinceIndex !== -1) lines = lines.slice(sinceIndex)
	}
	if (pagination.before) {
		const beforeIndex = lines.findIndex(message => message.eventId === pagination.before)
		if (beforeIndex !== -1) lines = lines.slice(0, beforeIndex)
	}
	if (Number.isFinite(messageLimit) && messageLimit > 0) lines = lines.slice(-messageLimit)
	return finalizeChannelMessagesForViewer(username, groupId, state, lines)
}

/**
 * 读取 pin ±N 邻域消息（checkpoint hot_posts.pinContexts + 冷归档）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {string} pinEventId 置顶消息 eventId
 * @returns {Promise<object[]>} 邻域消息行
 */
export async function readPinNeighborhoodForUser(username, groupId, channelId, pinEventId) {
	const checkpoint = await safeReadJson(snapshotPath(username, groupId))
	const eventIds = checkpoint?.hot_posts?.pinContexts?.[channelId]?.[pinEventId] || [pinEventId]
	return readChannelMessagesForUser(username, groupId, channelId, { eventIds })
}
