/**
 * 【文件】dagSession.mjs — DAG 物化 session 读取与 session_* 事件追加
 * 【职责】getMaterializedSession 从 DAG state.session 取绑定表；提供 appendSessionCharBind/Unbind、WorldBind、ChannelWorldBind、PersonaSet、PluginAdd/Remove、CharFrequencySet 等写操作。
 * 【原理】变更均通过 appendSignedLocalEvent 追加不可变事件，由 materialize 归约为 session 字段；sessionOwnerBinding 固定本机 ownerUsername + homeNodeHash；clear 世界分群级与频道级。
 * 【数据结构】session { chars, world, channelWorlds, personas, plugins, charFrequencies }，绑定含 charname/worldname/ownerUsername/homeNodeHash。
 * 【关联】dag/materialize、runtime、partConfig、sessionSnapshot。
 */
import { appendSignedLocalEvent } from '../dag/append.mjs'
import { getState } from '../dag/materialize.mjs'
import { getLocalNodeHash } from '../lib/replica.mjs'

/**
 * @param {string} replicaUsername 本地 replica 所有者
 * @param {string} groupId 群 ID
 * @returns {Promise<object>} 物化 state
 */
export async function getMaterializedSession(replicaUsername, groupId) {
	const { state } = await getState(replicaUsername, groupId)
	return state.session || {
		chars: {},
		world: null,
		channelWorlds: {},
		personas: {},
		plugins: {},
		charFrequencies: {},
	}
}

/**
 * @param {string} replicaUsername replica 所有者
 * @returns {{ ownerUsername: string, homeNodeHash: string }} 本机 replica 的部件归属绑定
 */
export function sessionOwnerBinding(replicaUsername) {
	return {
		ownerUsername: replicaUsername,
		homeNodeHash: getLocalNodeHash(),
	}
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} groupId 群 ID
 * @param {string} charname 角色名
 * @returns {Promise<void>}
 */
export async function appendSessionCharBind(replicaUsername, groupId, charname) {
	const bind = sessionOwnerBinding(replicaUsername)
	await appendSignedLocalEvent(replicaUsername, groupId, {
		type: 'session_char_bind',
		sender: replicaUsername,
		timestamp: Date.now(),
		content: { charname, ...bind },
	})
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} groupId 群 ID
 * @param {string} charname 角色名
 * @returns {Promise<void>}
 */
export async function appendSessionCharUnbind(replicaUsername, groupId, charname) {
	await appendSignedLocalEvent(replicaUsername, groupId, {
		type: 'session_char_unbind',
		sender: replicaUsername,
		timestamp: Date.now(),
		content: { charname },
	})
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} groupId 群 ID
 * @param {string | null} worldname 世界名；null 清除群级世界
 * @returns {Promise<void>}
 */
export async function appendSessionWorldBind(replicaUsername, groupId, worldname) {
	if (!worldname) {
		await appendSignedLocalEvent(replicaUsername, groupId, {
			type: 'session_world_clear',
			sender: replicaUsername,
			timestamp: Date.now(),
			content: {},
		})
		return
	}
	const bind = sessionOwnerBinding(replicaUsername)
	await appendSignedLocalEvent(replicaUsername, groupId, {
		type: 'session_world_bind',
		sender: replicaUsername,
		timestamp: Date.now(),
		content: { worldname, scope: 'group', ...bind },
	})
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {string | null} worldname 世界名；null 清除该频道世界
 * @returns {Promise<void>}
 */
export async function appendSessionChannelWorldBind(replicaUsername, groupId, channelId, worldname) {
	if (!worldname) {
		await appendSignedLocalEvent(replicaUsername, groupId, {
			type: 'session_world_clear',
			sender: replicaUsername,
			timestamp: Date.now(),
			content: { channelId },
		})
		return
	}
	const bind = sessionOwnerBinding(replicaUsername)
	await appendSignedLocalEvent(replicaUsername, groupId, {
		type: 'session_world_bind_channel',
		sender: replicaUsername,
		timestamp: Date.now(),
		content: { channelId, worldname, ...bind },
	})
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} groupId 群 ID
 * @param {string | null} personaname 人格名
 * @returns {Promise<void>}
 */
export async function appendSessionPersonaSet(replicaUsername, groupId, personaname) {
	await appendSignedLocalEvent(replicaUsername, groupId, {
		type: 'session_persona_set',
		sender: replicaUsername,
		timestamp: Date.now(),
		content: { ownerUsername: replicaUsername, personaname: personaname || null },
	})
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} groupId 群 ID
 * @param {string} pluginname 插件名
 * @returns {Promise<void>}
 */
export async function appendSessionPluginAdd(replicaUsername, groupId, pluginname) {
	await appendSignedLocalEvent(replicaUsername, groupId, {
		type: 'session_plugin_add',
		sender: replicaUsername,
		timestamp: Date.now(),
		content: { ownerUsername: replicaUsername, pluginname },
	})
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} groupId 群 ID
 * @param {string} pluginname 插件名
 * @returns {Promise<void>}
 */
export async function appendSessionPluginRemove(replicaUsername, groupId, pluginname) {
	await appendSignedLocalEvent(replicaUsername, groupId, {
		type: 'session_plugin_remove',
		sender: replicaUsername,
		timestamp: Date.now(),
		content: { ownerUsername: replicaUsername, pluginname },
	})
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} groupId 群 ID
 * @param {string} charname 角色名
 * @param {number} frequency 发言频率
 * @returns {Promise<void>}
 */
export async function appendSessionCharFrequencySet(replicaUsername, groupId, charname, frequency) {
	await appendSignedLocalEvent(replicaUsername, groupId, {
		type: 'session_char_frequency_set',
		sender: replicaUsername,
		timestamp: Date.now(),
		content: { charname, frequency },
	})
}

/**
 * @param {object} session 物化 session
 * @param {string} charname 角色名
 * @returns {boolean} 物化 session 是否已绑定该角色
 */
export function sessionHasChar(session, charname) {
	return !!session?.chars?.[charname]
}
