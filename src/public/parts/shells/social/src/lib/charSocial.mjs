/**
 * 加载角色时补齐 interfaces.social（对齐 telegrambot 对 interfaces.telegram 的处理）。
 */
import { loadPart } from '../../../../../../server/parts_loader.mjs'

/**
 * 确保角色 part 具备可用的 interfaces.social。
 * @param {string} username replica 登录名
 * @param {string} charPartName chars/ 目录名
 * @returns {Promise<object>} 已确保 social 接口可用的 char part
 */
export async function ensureCharSocialInterface(username, charPartName) {
	const char = await loadPart(username, `chars/${charPartName}`)
	const { createSimpleSocialInterface } = await import('../default_interface/main.mjs')
	char.interfaces.social ??= await createSimpleSocialInterface(char, username, charPartName)

	if (!char.interfaces.social.OnMention && char.interfaces.chat?.GetReply)
		char.interfaces.social.OnMention =
			(await createSimpleSocialInterface(char, username, charPartName)).OnMention

	return char
}
