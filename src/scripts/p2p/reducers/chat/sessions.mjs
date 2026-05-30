import { createEmptySessionState, refreshMembersDigest, withGroupId } from './helpers.mjs'

/** @type {Record<string, (state: object, event: object) => object>} */
export const sessionReducers = {
	/**
	 * 处理 `session_char_bind` 事件：将角色绑定写入 `session.chars`。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	session_char_bind(state, event) {
		withGroupId(state, event)
		if (!state.session) state.session = createEmptySessionState()
		const charname = String(event.content?.charname || '').trim()
		if (charname)
			state.session.chars[charname] = {
				ownerUsername: String(event.content?.ownerUsername || '').trim(),
				homeNodeHash: event.content?.homeNodeHash || '',
			}

		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `session_char_unbind` 事件：从 `session.chars` 移除角色绑定。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	session_char_unbind(state, event) {
		withGroupId(state, event)
		if (!state.session) {
			refreshMembersDigest(state)
			return state
		}
		const charname = String(event.content?.charname || '').trim()
		if (charname) delete state.session.chars[charname]
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `session_world_bind` 事件：设置群级默认世界绑定。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	session_world_bind(state, event) {
		withGroupId(state, event)
		if (!state.session) state.session = createEmptySessionState()
		state.session.world = {
			worldname: String(event.content?.worldname || '').trim(),
			ownerUsername: String(event.content?.ownerUsername || '').trim(),
			homeNodeHash: event.content?.homeNodeHash || '',
		}
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `session_world_bind_channel` 事件：为指定频道写入世界绑定。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	session_world_bind_channel(state, event) {
		withGroupId(state, event)
		if (!state.session) state.session = createEmptySessionState()
		const channelId = String(event.content?.channelId || '').trim()
		if (channelId)
			state.session.channelWorlds[channelId] = {
				worldname: String(event.content?.worldname || '').trim(),
				ownerUsername: String(event.content?.ownerUsername || '').trim(),
				homeNodeHash: event.content?.homeNodeHash || '',
			}

		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `session_world_clear` 事件：清除频道或群级世界绑定。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	session_world_clear(state, event) {
		withGroupId(state, event)
		if (!state.session) {
			refreshMembersDigest(state)
			return state
		}
		const channelId = String(event.content?.channelId || '').trim()
		if (channelId) delete state.session.channelWorlds[channelId]
		else state.session.world = null
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `session_persona_set` 事件：设置或清除用户的 persona 绑定。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	session_persona_set(state, event) {
		withGroupId(state, event)
		if (!state.session) state.session = createEmptySessionState()
		const ownerUsername = String(event.content?.ownerUsername || '').trim()
		if (ownerUsername) {
			const personaname = event.content?.personaname
			if (personaname == null || personaname === '')
				delete state.session.personas[ownerUsername]
			else
				state.session.personas[ownerUsername] = String(personaname).trim()
		}
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `session_plugin_add` 事件：向用户插件列表追加插件。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	session_plugin_add(state, event) {
		withGroupId(state, event)
		if (!state.session) state.session = createEmptySessionState()
		const ownerUsername = String(event.content?.ownerUsername || '').trim()
		const pluginname = String(event.content?.pluginname || '').trim()
		if (ownerUsername && pluginname) {
			if (!state.session.plugins[ownerUsername])
				state.session.plugins[ownerUsername] = []
			if (!state.session.plugins[ownerUsername].includes(pluginname))
				state.session.plugins[ownerUsername].push(pluginname)
		}
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `session_plugin_remove` 事件：从用户插件列表移除插件。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	session_plugin_remove(state, event) {
		withGroupId(state, event)
		if (!state.session) {
			refreshMembersDigest(state)
			return state
		}
		const ownerUsername = String(event.content?.ownerUsername || '').trim()
		const pluginname = String(event.content?.pluginname || '').trim()
		if (ownerUsername && pluginname) {
			const list = state.session.plugins[ownerUsername]
			if (Array.isArray(list)) {
				state.session.plugins[ownerUsername] = list.filter(name => name !== pluginname)
				if (!state.session.plugins[ownerUsername].length)
					delete state.session.plugins[ownerUsername]
			}
		}
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `session_char_frequency_set` 事件：设置角色自动回复频率。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	session_char_frequency_set(state, event) {
		withGroupId(state, event)
		if (!state.session) state.session = createEmptySessionState()
		const charname = String(event.content?.charname || '').trim()
		const frequency = Number(event.content?.frequency)
		if (charname && Number.isFinite(frequency))
			state.session.charFrequencies[charname] = frequency
		refreshMembersDigest(state)
		return state
	},
}
