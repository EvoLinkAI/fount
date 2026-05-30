/**
 * 【文件】src/chat/lib/messageMerge.mjs
 * 【职责】将频道 DAG 原始事件行折叠为 UI 可展示的「有效消息」列表：合并编辑快照、剔除已删消息、挂载反馈扩展。
 * 【原理】DAG 中 message / message_edit / message_delete / message_feedback 是独立事件，展示层需按 targetId 做 overlay 折叠。
 *   第一遍扫描收集 edits(Map)、deleted(Set)、feedbackByTarget(Map)；第二遍只输出 type=message 且未被删除的行，
 *   若存在编辑则用 mergeMessageContent 将 patch 叠到 base 上（文本消息走 textChannelContent 规范化）。
 *   同一 target 上多条 message_edit 时 Map 只保留最后一次（展示终稿，非 edit 历史链）。
 * 【数据结构】输入 messages[] 每行含 type、eventId/id、content（含 targetId、newContent、feedbackType 等）；
 *   输出为浅拷贝行，content.is_generating / fileCount 等来自编辑快照；extension.feedback 来自 feedback 事件。
 * 【关联】被 public/hub/messages 与物化查询消费；依赖 channelContent.mjs 的文本类型判断与合并。
 */
import { channelMessageContentObject, isTextChannelContent, textChannelContent } from './channelContent.mjs'

const OVERLAY_EVENT_TYPES = ['message_edit', 'message_delete', 'message_feedback']

/**
 * @param {object | undefined} base 原消息 content
 * @param {object | undefined} patch 编辑快照
 * @returns {object} 合并后的 content
 */
function mergeMessageContent(base, patch) {
	if (!isTextChannelContent(base) && !isTextChannelContent(patch))
		return { ...base, ...patch }
	if (!isTextChannelContent(base) || !isTextChannelContent(patch))
		throw new Error('text edit patch requires type text message')
	return channelMessageContentObject(textChannelContent(
		String(patch.content ?? base.content ?? ''),
		{
			content_for_show: patch.content_for_show ?? base.content_for_show,
			content_for_edit: patch.content_for_edit ?? base.content_for_edit,
		},
	))
}

/**
 * @param {object} row 消息或 overlay 行
 * @returns {string} 目标消息 eventId
 */
function overlayTargetId(row) {
	if (row.type === 'message') return String(row.eventId).trim()
	return String(row.content.targetId).trim()
}

/**
 * @param {object} row 原始 message 行
 * @param {object | null} feedback 反馈 overlay
 * @param {object | undefined} feedbackExtension 已解析的 feedback 扩展
 * @returns {object} 带 extension.feedback 的行
 */
function withFeedbackExtension(row, feedback, feedbackExtension) {
	return {
		...row,
		extension: { ...row.extension, feedback: feedbackExtension },
	}
}

/**
 * @param {object[]} messages 频道原始行（含 overlay 事件）
 * @returns {object[]} 折叠后的展示行
 */
export function mergeChannelMessagesForDisplay(messages) {
	const edits = new Map()
	const deleted = new Set()
	const feedbackByTarget = new Map()
	for (const row of messages) {
		const targetId = overlayTargetId(row)
		if (!targetId) continue
		if (row.type === 'message_edit') edits.set(targetId, row.content)
		if (row.type === 'message_delete') deleted.add(targetId)
		if (row.type === 'message_feedback') feedbackByTarget.set(targetId, row)
	}
	const merged = []
	for (const row of messages) {
		if (OVERLAY_EVENT_TYPES.includes(row.type)) continue
		if (row.type !== 'message') {
			merged.push(row)
			continue
		}
		const targetId = overlayTargetId(row)
		if (targetId && deleted.has(targetId)) continue
		const feedback = targetId ? feedbackByTarget.get(targetId) : null
		const feedbackExtension = feedback?.content?.feedbackType
			? { type: feedback.content.feedbackType, content: feedback.content.feedbackContent || '' }
			: row.extension?.feedback
		if (targetId && edits.has(targetId)) {
			const patch = edits.get(targetId)?.newContent || edits.get(targetId)
			const content = {
				...mergeMessageContent(row.content, patch),
				...patch?.fileCount != null ? { fileCount: patch.fileCount } : {},
			}
			if (patch && 'is_generating' in patch)
				content.is_generating = !!patch.is_generating
			merged.push(withFeedbackExtension({ ...row, content, wasEdited: true }, feedback, feedbackExtension))
			continue
		}
		if (feedback) {
			merged.push(withFeedbackExtension(row, feedback, feedbackExtension))
			continue
		}
		merged.push(row)
	}
	return merged
}
