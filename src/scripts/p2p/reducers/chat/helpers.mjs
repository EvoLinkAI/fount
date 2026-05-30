import { MEMBERS_PAGE_SIZE } from '../../constants.mjs'
import { merkleRoot } from '../../dag/index.mjs'
import { isHex64 } from '../../hexIds.mjs'
import { sanitizeIceServersForSettings } from '../../ice_servers.mjs'

/**
 * @param {object} state 物化状态
 * @returns {void}
 */
export function refreshMembersDigest(state) {
	const activeKeys = Object.entries(state.members || {})
		.filter(([, member]) => member?.status === 'active')
		.map(([memberKey]) => memberKey)
		.sort()
	state.membersRoot = activeKeys.length ? merkleRoot(activeKeys) : null
	state.membersPagesCount = Math.max(1, Math.ceil(activeKeys.length / MEMBERS_PAGE_SIZE))
}

/**
 * @param {unknown} value 事件中的原始数值
 * @returns {number} 限制在 [-1, 1] 的声誉边权
 */
export function clampRepEdge(value) {
	const number = Number(value)
	if (!Number.isFinite(number)) return 1
	return Math.max(-1, Math.min(1, number))
}

/**
 * @param {object} state 物化状态
 * @param {object} event DAG 事件
 * @param {'kick' | 'rotate'} rotationType GSH 轮换原因
 * @param {Record<string, unknown>} [extra] 附加字段
 * @returns {void}
 */
export function recordGshRotation(state, event, rotationType, extra = {}) {
	const generation = event.content?.key_generation
	const nonce = event.content?.new_H_nonce
	if (!Number.isFinite(generation) || !nonce) return
	state.gshRotations.push({
		eventId: event.id,
		generation,
		nonce,
		type: rotationType,
		...extra,
	})
}

/**
 * @param {object} state 物化群状态
 * @param {string} sender pubKeyHash
 * @param {object} [joinContent] member_join content
 * @returns {boolean} 是否应拒绝该成员加入
 */
export function isJoinBanned(state, sender, joinContent = {}) {
	if (state.bannedMembers?.has?.(sender)) return true
	const home = joinContent.homeNodeHash || state.members?.[sender]?.homeNodeHash
	if (home && isHex64(home)) {
		if (state.bannedNodes?.has?.(home)) return true
		if (state.bannedEntities?.has?.(`${home}${sender}`)) return true
	}
	return false
}

/**
 * @param {object} state 物化群状态
 * @param {object} content member_ban content
 * @returns {void}
 */
export function applyBanContent(state, content) {
	const pk = content?.targetPubKeyHash
	if (pk) state.bannedMembers.add(pk)
	const entity = content?.targetEntityHash
	if (entity && /^[\da-f]{128}$/u.test(entity)) state.bannedEntities.add(entity)
	const node = content?.targetNodeHash
	if (node && isHex64(node)) state.bannedNodes.add(node)
}

/**
 * @param {object} state 物化群状态
 * @param {string} targetPubKeyHash 成员 pubKeyHash
 * @returns {void}
 */
export function clearBanForMember(state, targetPubKeyHash) {
	const pk = targetPubKeyHash
	if (!pk) return
	state.bannedMembers.delete(pk)
	const member = state.members?.[pk]
	const home = member?.homeNodeHash
	if (home && isHex64(home)) {
		state.bannedNodes.delete(home)
		state.bannedEntities.delete(`${home}${pk}`)
	}
}

/**
 * @param {object} state 物化状态
 * @param {object} event DAG 事件
 * @returns {object} 更新 groupId 后的 state
 */
export function withGroupId(state, event) {
	if (event?.groupId) state.groupId = event.groupId
	return state
}

/**
 * 空 AI 会话配置（由 session_* DAG 事件物化）。
 * @returns {object} 初始 session 物化字段
 */
export function createEmptySessionState() {
	return {
		chars: {},
		world: null,
		channelWorlds: {},
		personas: {},
		plugins: {},
		charFrequencies: {},
	}
}

/**
 * P2P chat reducer 通用工具（自 `ice_servers`、`hexIds` 再导出）。
 */
export { sanitizeIceServersForSettings, isHex64 }
