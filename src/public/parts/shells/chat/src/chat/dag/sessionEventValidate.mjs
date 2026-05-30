/**
 * 【文件】`dag/sessionEventValidate.mjs` — `session_*` DAG 事件内容校验。
 * 【职责】联邦入站时校验角色/世界/插件/人设等会话绑定事件的 `content` 必填字段与频道 id 合法性。
 * 【原理】`session_*` 类型跳过通用权限矩阵，仅做形状校验；绑定类事件要求 `charname`/`worldname`、`ownerUsername`、`homeNodeHash` 等非空。
 * 【数据结构】按 `event.type` 分支校验 `event.content` 对象字段。
 * 【关联】`ingest.mjs`、`syncScope.mjs`。
 */
import { isChannelIdValid } from '../lib/channelId.mjs'

/**
 * 校验 session_* DAG 事件 content 形状（联邦入站）。
 * @param {object} event 事件体
 * @returns {void}
 */
export function validateSessionEventContent(event) {
	const content = event?.content || {}
	switch (event.type) {
		case 'session_char_bind': {
			if (!content.charname?.trim()) throw new Error('session_char_bind: charname required')
			if (!content.ownerUsername?.trim()) throw new Error('session_char_bind: ownerUsername required')
			if (!content.homeNodeHash?.trim()) throw new Error('session_char_bind: homeNodeHash required')
			break
		}
		case 'session_char_unbind': {
			if (!content.charname?.trim()) throw new Error('session_char_unbind: charname required')
			break
		}
		case 'session_world_bind': {
			if (!content.worldname?.trim()) throw new Error('session_world_bind: worldname required')
			if (!content.ownerUsername?.trim()) throw new Error('session_world_bind: ownerUsername required')
			if (!content.homeNodeHash?.trim()) throw new Error('session_world_bind: homeNodeHash required')
			break
		}
		case 'session_world_bind_channel': {
			if (!isChannelIdValid(content.channelId)) throw new Error('session_world_bind_channel: channelId required')
			if (!content.worldname?.trim()) throw new Error('session_world_bind_channel: worldname required')
			if (!content.ownerUsername?.trim()) throw new Error('session_world_bind_channel: ownerUsername required')
			if (!content.homeNodeHash?.trim()) throw new Error('session_world_bind_channel: homeNodeHash required')
			break
		}
		case 'session_world_clear': {
			if (content.channelId != null && !isChannelIdValid(content.channelId))
				throw new Error('session_world_clear: invalid channelId')
			break
		}
		case 'session_persona_set': {
			if (!content.ownerUsername?.trim()) throw new Error('session_persona_set: ownerUsername required')
			break
		}
		case 'session_plugin_add':
		case 'session_plugin_remove': {
			if (!content.ownerUsername?.trim()) throw new Error(`${event.type}: ownerUsername required`)
			if (!content.pluginname?.trim()) throw new Error(`${event.type}: pluginname required`)
			break
		}
		case 'session_char_frequency_set': {
			if (!content.charname?.trim()) throw new Error('session_char_frequency_set: charname required')
			if (!Number.isFinite(Number(content.frequency))) throw new Error('session_char_frequency_set: frequency required')
			break
		}
		default:
			break
	}
}
