/**
 * 【文件】public/src/lib/channelContent.mjs
 * 【职责】频道 DAG 消息 content 对象规范（浏览器与 Deno 共用）：type 必填，text 三分字段。
 * 【原理】textChannelContent 组装 agent/show/edit 文本；channelMessageContentObject 规范化传入对象。
 * 【数据结构】{ type:'text', content, content_for_show?, content_for_edit? } 及扩展字段。
 * 【关联】api/groupChannel.mjs、src/chat/lib/messageMerge.mjs；后端消息校验。
 */
/** @typedef {'text' | 'sticker' | 'vote' | 'group_invite'} ChannelContentType */

/**
 * @param {unknown} content 消息 content
 * @returns {content is Record<string, unknown>} 是否为对象
 */
function isContentObject(content) {
	return content != null && typeof content === 'object'
}

/**
 * @param {unknown} content 消息 content
 * @returns {ChannelContentType} 内容类型
 */
export function channelContentType(content) {
	if (!isContentObject(content)) throw new Error('content must be an object')
	const { type } = content
	if (type === 'text' || type === 'sticker' || type === 'vote' || type === 'group_invite') return type
	throw new Error(`unknown content.type: ${String(type)}`)
}

/**
 * @param {unknown} content 消息 content
 * @returns {boolean} 是否为文本类载荷
 */
export function isTextChannelContent(content) {
	return channelContentType(content) === 'text'
}

/**
 * @param {Record<string, unknown>} raw 已含 `type: 'text'` 的对象
 * @returns {Record<string, unknown>} 校验后的文本载荷
 */
function finalizeTextChannelContent(raw) {
	if (raw.type !== 'text') throw new Error('expected type text')
	if (typeof raw.content !== 'string') throw new Error('text content requires string content field')
	/** @type {Record<string, unknown>} */
	const out = { ...raw, type: 'text', content: raw.content }
	if (out.content_for_show != null) {
		if (typeof out.content_for_show !== 'string') throw new Error('content_for_show must be a string')
		if (out.content_for_show === out.content) delete out.content_for_show
	}
	else delete out.content_for_show
	if (out.content_for_edit != null) {
		if (typeof out.content_for_edit !== 'string') throw new Error('content_for_edit must be a string')
		if (out.content_for_edit === out.content) delete out.content_for_edit
	}
	else delete out.content_for_edit
	return out
}

/**
 * @param {string} agentText agent 正文
 * @param {{ content_for_show?: string, content_for_edit?: string } & Record<string, unknown>} [extra] 其它字段（fileIds 等）
 * @returns {Record<string, unknown>} `type: 'text'` 载荷
 */
export function textChannelContent(agentText, extra = {}) {
	if (typeof agentText !== 'string') throw new Error('agentText must be a string')
	const { content_for_show, content_for_edit, ...rest } = extra
	return finalizeTextChannelContent({
		type: 'text',
		content: agentText,
		...rest,
		...content_for_show != null ? { content_for_show: String(content_for_show) } : {},
		...content_for_edit != null ? { content_for_edit: String(content_for_edit) } : {},
	})
}

/**
 * @param {unknown} input 写入 DAG 的 content
 * @returns {Record<string, unknown>} 校验后的对象
 */
export function channelMessageContentObject(input) {
	if (!isContentObject(input)) throw new Error('content must be an object')
	if (input.type === 'text') return finalizeTextChannelContent(/** @type {Record<string, unknown>} */ input)
	channelContentType(input)
	return { .../** @type {Record<string, unknown>} */ input }
}

/**
 * @param {unknown} content 消息 content
 * @returns {string} agent 正文
 */
export function channelMessageAgentText(content) {
	if (!isContentObject(content)) return ''
	if (content.type === 'vote') return String(content.question || '').trim()
	if (content.type !== 'text') return ''
	return String(content.content)
}

/**
 * @param {unknown} content 消息 content
 * @returns {string} 给人看的正文
 */
export function channelMessageShowText(content) {
	if (!isContentObject(content)) return ''
	if (content.type === 'vote') return String(content.question || '').trim()
	if (content.type !== 'text') return ''
	return String(content.content_for_show ?? content.content)
}

/**
 * @param {unknown} content 消息 content
 * @returns {string} 给人编辑的正文
 */
export function channelMessageEditText(content) {
	if (!isContentObject(content)) return ''
	if (content.type !== 'text') return ''
	return String(content.content_for_edit ?? content.content)
}

/**
 * @param {unknown} content 消息 content
 * @returns {string} 展示/搜索用正文
 */
export function channelMessageText(content) {
	return channelMessageShowText(content)
}
