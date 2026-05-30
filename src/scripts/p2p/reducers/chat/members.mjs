import {
	applyBanContent,
	clearBanForMember,
	clampRepEdge,
	isHex64,
	isJoinBanned,
	recordGshRotation,
	refreshMembersDigest,
	withGroupId,
} from './helpers.mjs'

/** @type {Record<string, (state: object, event: object) => object>} */
export const memberReducers = {
	/**
	 * 处理 `member_join` 事件：登记新成员并可选记录邀请边。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	member_join(state, event) {
		withGroupId(state, event)
		if (!isJoinBanned(state, event.sender, event.content)) {
			const activeBefore = Object.values(state.members).filter(m => m?.status === 'active').length
			const extraRoles = activeBefore === 0 && Array.isArray(event.content?.roles)
				? event.content.roles.filter(roleId => typeof roleId === 'string' && roleId && roleId !== '@everyone' && state.roles[roleId])
				: []
			const homeNodeHash = event.content?.homeNodeHash || event.senderHomeNodeHash
			state.members[event.sender] = {
				pubKeyHash: event.sender,
				pubKeyHex: event.senderPubKey || event.content?.pubKeyHex || null,
				homeNodeHash: homeNodeHash && isHex64(homeNodeHash) ? homeNodeHash : null,
				roles: ['@everyone', ...extraRoles],
				joinedAt: event.timestamp,
				status: 'active',
				repEdgeFromIntroducer: clampRepEdge(event.content?.reputationEdge),
			}
			const introducer = event.content?.introducerPubKeyHash
			const joiner = event.sender
			if (introducer && isHex64(introducer) && isHex64(joiner) && introducer !== joiner) {
				const dup = state.inviteEdges.some(edge => edge.from === introducer && edge.to === joiner)
				if (!dup) {
					const edge = { from: introducer, to: joiner, at: event.timestamp }
					if (event.content?.reputationEdge !== undefined)
						edge.reputationEdge = clampRepEdge(event.content.reputationEdge)
					state.inviteEdges.push(edge)
				}
			}
		}
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `member_leave` 事件：将发送方成员状态设为 `left`。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	member_leave(state, event) {
		withGroupId(state, event)
		if (state.members[event.sender])
			state.members[event.sender].status = 'left'
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `member_kick` 事件：将目标成员状态设为 `kicked` 并记录 GSH 轮换。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	member_kick(state, event) {
		withGroupId(state, event)
		const target = event.content?.targetPubKeyHash
		if (target && state.members[target])
			state.members[target].status = 'kicked'
		recordGshRotation(state, event, 'kick', { targetPubKeyHash: target })
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `member_ban` 事件：写入封禁集合并将目标成员状态设为 `banned`。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	member_ban(state, event) {
		withGroupId(state, event)
		applyBanContent(state, event.content || {})
		const target = event.content?.targetPubKeyHash
		if (target && state.members[target])
			state.members[target].status = 'banned'
		refreshMembersDigest(state)
		return state
	},

	/**
	 * 处理 `member_unban` 事件：清除目标封禁记录并恢复成员为 `active`。
	 * @param {object} state 物化群状态
	 * @param {object} event DAG 事件
	 * @returns {object} 更新后的 state
	 */
	member_unban(state, event) {
		withGroupId(state, event)
		const target = event.content?.targetPubKeyHash
		clearBanForMember(state, target)
		if (target && state.members[target])
			state.members[target].status = 'active'
		refreshMembersDigest(state)
		return state
	},
}
