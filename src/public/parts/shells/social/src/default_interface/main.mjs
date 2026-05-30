/**
 * 为未定义 interfaces.social 的老旧角色提供默认 Social 面板（OnMention → chat.GetReply）。
 * 模式对齐 shells/telegrambot/src/default_interface。
 */

/** @typedef {import('../../../../../../decl/charAPI.ts').CharAPI_t} CharAPI_t */
/** @typedef {import('../../../../../../decl/socialAPI.ts').SocialMentionEvent} SocialMentionEvent */
/** @typedef {import('../../../../../../decl/socialAPI.ts').SocialHandlerResult} SocialHandlerResult */

/**
 * 为老旧角色创建默认 Social 接口（OnMention 经 chat.GetReply 生成公开回复）。
 * @param {CharAPI_t} charAPI 角色 part
 * @param {string} ownerUsername replica 登录名
 * @param {string} charPartName chars/ 目录名
 * @returns {Promise<NonNullable<CharAPI_t['interfaces']['social']>>} 默认 social 接口
 */
export async function createSimpleSocialInterface(charAPI, ownerUsername, charPartName) {
	if (!charAPI?.interfaces?.chat?.GetReply)
		throw new Error('charAPI.interfaces.chat.GetReply is required for SimpleSocialInterface.')

	/**
	 * 处理 @ 提及：构造 chat 提示并返回适合公开发布的 Markdown 回复。
	 * @param {SocialMentionEvent} event 提及上下文
	 * @returns {Promise<SocialHandlerResult>} 公开回复正文；无内容时 skip
	 */
	async function OnMention(event) {
		const promptUserText = [
			'有人在 fount Social 动态中 @ 了你。',
			`作者 entityHash：${event.authorEntityHash}`,
			`作者显示名：${event.authorDisplayName}`,
			`原帖：${event.postText}`,
			'请用适合公开发布的简短 Markdown 回复（不要解释你是 AI）。',
		].join('\n')

		/** @type {import('../../../../../../decl/prompt_struct.ts').chatLogEntry_t[]} */
		const chat_log = [{
			role: 'user',
			name: 'social',
			content: promptUserText,
		}]

		/**
		 * 构建 chat.GetReply 请求体。
		 * @returns {Promise<object>} chat 回复请求
		 */
		const buildRequest = async () => ({
			supported_functions: { markdown: true },
			username: ownerUsername,
			chat_name: 'Social',
			char_id: charPartName,
			Charname: charPartName,
			UserCharname: 'social',
			ReplyToCharname: 'social',
			locales: ['zh-CN', 'en-UK'],
			time: new Date(),
			world: null,
			user: null,
			char: charAPI,
			other_chars: [],
			plugins: {},
			chat_scoped_char_memory: {},
			chat_log,
			/**
			 * Social 自动回复无需写入 chat 日志（空实现）。
			 * @returns {Promise<void>}
			 */
			AddChatLogEntry: async () => { },
			Update: buildRequest,
			extension: {
				platform: 'social',
				mention: {
					authorEntityHash: event.authorEntityHash,
					postId: event.postId,
					mentionedEntityHash: event.mentionedEntityHash,
				},
			},
		})

		const reply = await charAPI.interfaces.chat.GetReply(await buildRequest())
		const text = String(reply?.content || '').trim()
		return text || null
	}

	return { OnMention }
}
