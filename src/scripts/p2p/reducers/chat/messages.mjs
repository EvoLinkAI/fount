import { isHex64, refreshMembersDigest, withGroupId } from './helpers.mjs'

/** @type {Record<string, (state: object, event: object) => object>} */
export const messageReducers = {
	/**
	 * 处理 `message` 事件：写入消息发送方索引（`messageSenderIndex`）。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	message(state, event) {
		withGroupId(state, event)
		const eventId = event.id
		if (isHex64(eventId)) {
			const channelId = event.channelId || event.content?.channelId || 'default'
			if (!state.messageSenderIndex) state.messageSenderIndex = {}
			const charOwner = event.content?.charOwner
			state.messageSenderIndex[eventId] = {
				sender: event.sender,
				charOwner: charOwner && isHex64(charOwner) ? charOwner : null,
				charId: event.charId || null,
				channelId,
			}
		}
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `message_delete` 事件：将目标消息 id 加入删除集合并清除发送方索引。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	message_delete(state, event) {
		withGroupId(state, event)
		const targetId = event.content?.targetId
		if (targetId) state.messageOverlay.deletedIds.add(targetId)
		if (targetId && state.messageSenderIndex) delete state.messageSenderIndex[targetId]
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `message_edit` 事件：记录目标消息的最新编辑内容。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	message_edit(state, event) {
		withGroupId(state, event)
		const targetId = event.content?.targetId
		if (targetId)
			state.messageOverlay.editHistory.set(targetId, event.content.newContent)
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `reaction_add` 事件：为消息 emoji 追加投票者。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	reaction_add(state, event) {
		withGroupId(state, event)
		const targetId = event.content?.targetId
		const emoji = event.content?.emoji
		if (!targetId || !emoji) {
			refreshMembersDigest(state)
			return state
		}
		const key = `${targetId}:${emoji}`
		let voters = state.messageOverlay.reactions.get(key)
		if (!voters) {
			voters = new Set()
			state.messageOverlay.reactions.set(key, voters)
		}
		voters.add(event.sender)
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `reaction_remove` 事件：从消息 emoji 移除投票者，空集时删除键。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	reaction_remove(state, event) {
		withGroupId(state, event)
		const targetId = event.content?.targetId
		const emoji = event.content?.emoji
		if (!targetId || !emoji) {
			refreshMembersDigest(state)
			return state
		}
		const key = `${targetId}:${emoji}`
		const voters = state.messageOverlay.reactions.get(key)
		if (!voters) {
			refreshMembersDigest(state)
			return state
		}
		const voterHash = event.content?.targetPubKeyHash || event.sender
		if (isHex64(voterHash)) voters.delete(voterHash)
		if (!voters.size) state.messageOverlay.reactions.delete(key)
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `pin_message` 事件：将消息 id 追加到频道置顶列表。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	pin_message(state, event) {
		withGroupId(state, event)
		if (!state.messageOverlay.pins.has(event.channelId))
			state.messageOverlay.pins.set(event.channelId, [])
		const pins = state.messageOverlay.pins.get(event.channelId)
		if (!pins.includes(event.content.targetId))
			pins.push(event.content.targetId)
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `unpin_message` 事件：从频道置顶列表移除消息 id。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	unpin_message(state, event) {
		withGroupId(state, event)
		if (state.messageOverlay.pins.has(event.channelId))
			state.messageOverlay.pins.set(
				event.channelId,
				state.messageOverlay.pins.get(event.channelId).filter(id => id !== event.content.targetId),
			)
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `vote_cast` 事件：记录选票上的选民选择与选项。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	vote_cast(state, event) {
		withGroupId(state, event)
		const { ballotId, choice } = event.content || {}
		if (ballotId && choice != null && event.sender) {
			if (!state.messageOverlay.votes.has(ballotId))
				state.messageOverlay.votes.set(ballotId, new Map())
			state.messageOverlay.votes.get(ballotId).set(event.sender, String(choice))
		}
		refreshMembersDigest(state)
		return state
	},
}
