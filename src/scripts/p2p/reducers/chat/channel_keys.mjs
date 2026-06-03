import { withGroupId } from './helpers.mjs'

/** @type {Record<string, (state: object, event: object) => object>} */
export const channelKeyReducers = {
	/**
	 * @param {object} state
	 * @param {object} event
	 * @returns {object}
	 */
	channel_key_rotate(state, event) {
		withGroupId(state, event)
		const channelId = String(event.content?.channelId || '').trim()
		const generation = Number(event.content?.generation)
		if (!channelId || !Number.isFinite(generation)) return state
		if (!state.channelKeyGeneration) state.channelKeyGeneration = {}
		state.channelKeyGeneration[channelId] = generation
		return state
	},
}
