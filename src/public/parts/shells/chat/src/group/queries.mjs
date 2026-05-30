/**
 * 【文件】group/queries.mjs
 * 【职责】群侧栏列表、频道消息读取与 reaction 事件查询，为 HTTP/Hub 提供聚合读模型。
 * 【原理】遍历 userGroups 物化 state 过滤本机活跃成员；读 messages.jsonl 后 merge、解密、分页并解析 content_ref；为查看者附加 isRemote/authorPubKeyHash。
 * 【数据结构】群列表行、消息行（eventId/content/charId）、reaction 精简事件、分页参数 since/before/limit。
 * 【关联】被 group/routes/groups.mjs、channels.mjs 调用；依赖 chat/dag、chat/gsh、messageMerge、access.mjs。
 */
import { DEFAULT_STREAM_GENERATING_IDLE_MS } from '../../../../../../scripts/p2p/constants.mjs'
import { isHex64 } from '../../../../../../scripts/p2p/hexIds.mjs'
import { getState } from '../chat/dag/materialize.mjs'
import { computeLastGroupActivityMs } from '../chat/dag/queries.mjs'
import { readJsonl } from '../chat/dag/storage.mjs'
import { resolveContentRefsInMessageLines } from '../chat/files/contentRefResolve.mjs'
import { decryptChannelMessageLines } from '../chat/gsh/content.mjs'
import { mergeChannelMessagesForDisplay } from '../chat/lib/messageMerge.mjs'
import { eventsPath, messagesPath } from '../chat/lib/paths.mjs'
import { listUserGroups } from '../chat/lib/userGroups.mjs'

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
		const senderKey = line.sender.trim().toLowerCase()
		const authorPubKeyHash = isHex64(senderKey) ? senderKey : null
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
	const thresholdMs = idleMs > 0 ? idleMs : DEFAULT_STREAM_GENERATING_IDLE_MS
	const now = Date.now()
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
	for (const groupId of await listUserGroups(username)) 
		try {
			const { state } = await getState(username, groupId)
			if (!await resolveActiveMemberKeyForLocalUser(username, groupId, state)) continue
			const activeMembers = Object.values(state.members).filter(member => member.status === 'active')
			rows.push({
				groupId,
				name: state.groupMeta?.name || groupId,
				description: state.groupMeta?.description ?? '',
				avatar: state.groupMeta?.avatar ?? null,
				defaultChannelId: state.groupSettings?.defaultChannelId ?? null,
				memberCount: activeMembers.length,
				channelCount: Object.keys(state.channels).length,
				lastMessageTime: await computeLastGroupActivityMs(username, groupId),
				friendBinding: state.groupMeta?.friendBinding || null,
			})
		}
		catch {
			// 新建群物化尚未就绪时跳过该条，避免整表 GET /groups 失败导致侧栏空白
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
	const events = await readJsonl(eventsPath(username, groupId))
	return events
		.filter(event => ['reaction_add', 'reaction_remove'].includes(event.type) && (event.channelId || 'default') === channelId)
		.map(event => ({
			type: event.type,
			sender: event.sender,
			content: event.content,
			eventId: event.id,
			timestamp: event.timestamp ?? event.hlc?.wall,
		}))
}

/**
 * 读取频道消息 JSONL、解密、折叠 append 链并解析 content_ref。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {{ since?: string, before?: string, limit?: string | number }} q 分页参数
 * @returns {Promise<object[]>} 消息行对象数组
 */
export async function readChannelMessagesForUser(username, groupId, channelId, q) {
	let lines = await readJsonl(messagesPath(username, groupId, channelId))
	lines = await decryptChannelMessageLines(username, groupId, channelId, lines)
	lines = mergeChannelMessagesForDisplay(lines)
	if (q.since) {
		const sinceIndex = lines.findIndex(message => message.eventId === q.since)
		// 含 since 行本身：`message_edit` 终稿会就地更新同 eventId，slice(+1) 会漏掉终稿
		if (sinceIndex !== -1) lines = lines.slice(sinceIndex)
	}
	if (q.before) {
		const beforeIndex = lines.findIndex(message => message.eventId === q.before)
		if (beforeIndex !== -1) lines = lines.slice(0, beforeIndex)
	}
	const lim = q.limit != null ? Number(q.limit) : undefined
	if (Number.isFinite(lim) && lim > 0) lines = lines.slice(-lim)
	const { state } = await getState(username, groupId)
	const idle = Number(state.groupSettings?.streamGeneratingIdleMs)
	const streamIdleMs = Number.isFinite(idle) && idle > 0 ? idle : undefined
	const memberKey = await resolveActiveMemberKeyForLocalUser(username, groupId, state)
	const viewerPubKeyHash = memberKey ? state.members[memberKey].pubKeyHash || memberKey : username
	return enrichChannelMessagesForViewer(
		await resolveContentRefsInMessageLines(username, markStaleGeneratingMessages(lines, streamIdleMs)),
		viewerPubKeyHash,
	)
}
