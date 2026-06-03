import { appendSignedLocalEvent } from '../dag/append.mjs'
import { getState } from '../dag/materialize.mjs'

import { buildChannelKeyRotateContent } from './rotate.mjs'

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @returns {Promise<object | null>} 签名事件
 */
export async function appendChannelKeyRotate(username, groupId, channelId) {
	const id = String(channelId || '').trim()
	if (!id) return null
	const { state } = await getState(username, groupId)
	if (!state.channels[id]) return null
	const content = buildChannelKeyRotateContent(state, id)
	return appendSignedLocalEvent(username, groupId, {
		type: 'channel_key_rotate',
		channelId: id,
		timestamp: Date.now(),
		content,
	})
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @returns {Promise<void>}
 */
export async function rotateAllChannelKeys(username, groupId) {
	const { state } = await getState(username, groupId)
	for (const channelId of Object.keys(state.channels || {}))
		await appendChannelKeyRotate(username, groupId, channelId)
}
