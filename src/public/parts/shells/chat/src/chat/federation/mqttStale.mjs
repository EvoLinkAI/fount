/**
 * 本机 MQTT 联邦「可能过期」标记（口令轮换后 catchup 失败时置位）。
 */
import { federationBootstrapKey } from './bootstrapStore.mjs'

/** @type {Map<string, { markedAt: number, failCount: number }>} */
const staleByKey = new Map()

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {string} Map 键
 */
function key(username, groupId) {
	return federationBootstrapKey(username, groupId)
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {void}
 */
export function markMqttCredentialsStale(username, groupId) {
	const k = key(username, groupId)
	const prev = staleByKey.get(k)
	staleByKey.set(k, {
		markedAt: Date.now(),
		failCount: (prev?.failCount || 0) + 1,
	})
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {boolean} 是否已标记 stale
 */
export function isMqttCredentialsStale(username, groupId) {
	return staleByKey.has(key(username, groupId))
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {void}
 */
export function clearMqttCredentialsStale(username, groupId) {
	staleByKey.delete(key(username, groupId))
}
