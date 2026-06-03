/**
 * 【文件】governance/banRules.mjs
 * 【职责】member_ban DAG 事件内容与物化态 banned* 集合的构建、解析及发送者是否被禁言判定。
 * 【原理】ban 可指向 entityHash 或 nodeHash 作用域；blockKeysFromBanContent 展开为 state 键；unban 时 member_unban 清理。联邦/本地 append 共用同一套规则，配合 peers 拉黑表。
 * 【数据结构】BanScope entity|node；content 含 targetPubKeyHash、targetEntityHash/targetNodeHash；state.bannedMembers/Entities/Nodes 为 Set。
 * 【关联】dag/authorizeEvent、peers.mjs、blocklist.mjs、entityId.mjs；scripts/p2p/event_types。
 */
import { isHex64, normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { memberEntityHash, parseEntityHash } from '../lib/entityId.mjs'

/**
 * @param {unknown} value entityHash
 * @returns {boolean} 是否为 128 位 entityHash
 */
function isEntityHash128(value) {
	return !!parseEntityHash(value)
}

/** @typedef {'entity' | 'node'} BanScope */

/** @type {Set<BanScope>} */
export const BAN_SCOPES = new Set(['entity', 'node'])

/**
 * @param {unknown} scope 封禁范围
 * @returns {boolean} 是否为合法 BanScope
 */
export function isBanScope(scope) {
	return BAN_SCOPES.has(/** @type {BanScope} */ scope)
}

/**
 * 构造 `member_ban` 事件 content。
 * @param {BanScope} banScope entity | node
 * @param {object} memberRow 物化成员
 * @returns {object} DAG content
 */
export function buildMemberBanContent(banScope, memberRow) {
	const targetPubKeyHash = normalizeHex64(memberRow?.pubKeyHash || '')
	if (!isHex64(targetPubKeyHash))
		throw new Error('invalid member pubKeyHash')
	/** @type {Record<string, string>} */
	const content = { banScope, targetPubKeyHash }
	const homeNodeHash = normalizeHex64(memberRow?.homeNodeHash || '')

	if (banScope === 'entity') {
		const targetEntityHash = memberEntityHash(memberRow)
		if (!isEntityHash128(targetEntityHash))
			throw new Error('member missing homeNodeHash for entity ban')
		content.targetEntityHash = targetEntityHash
	}
	if (banScope === 'node') {
		if (!isHex64(homeNodeHash))
			throw new Error('member missing homeNodeHash for node ban')
		content.targetNodeHash = homeNodeHash
	}
	return content
}

/**
 * 从 ban 事件 content 收集应写入 peers/blocklist 的键。
 * @param {object} content member_ban content
 * @returns {string[]} 去重后的 block 键
 */
export function blockKeysFromBanContent(content) {
	return blockEntriesFromBanContent(content).map(entry => entry.value)
}

/**
 * 从 ban 事件 content 收集应写入 peers/blocklist 的 scope 化条目。
 * @param {object} content member_ban content
 * @returns {Array<{ scope: 'subject' | 'entity' | 'node', value: string }>} 去重后的 block 条目
 */
export function blockEntriesFromBanContent(content) {
	/** @type {Map<string, { scope: 'subject' | 'entity' | 'node', value: string }>} */
	const entries = new Map()
	/**
	 * @param {'subject' | 'entity' | 'node'} scope 拉黑范围
	 * @param {string} value 键值
	 */
	const add = (scope, value) => {
		if (!value) return
		entries.set(`${scope}:${value}`, { scope, value })
	}
	const pk = normalizeHex64(content?.targetPubKeyHash)
	if (isHex64(pk)) add('subject', pk)
	const entity = String(content?.targetEntityHash || '').trim().toLowerCase()
	if (isEntityHash128(entity)) add('entity', entity)
	const node = normalizeHex64(content?.targetNodeHash)
	if (isHex64(node)) add('node', node)
	return [...entries.values()]
}

/**
 * 成员是否被群级 ban 规则拒绝入群/活动。
 * @param {object} state 物化群状态
 * @param {string} sender 发送方 pubKeyHash
 * @param {object} [joinContent] member_join content
 * @returns {boolean} 是否被群 ban 规则拒绝
 */
export function isSenderBannedByState(state, sender, joinContent = {}) {
	const pk = normalizeHex64(sender)
	if (!isHex64(pk)) return false
	if (state.bannedMembers?.has?.(pk)) return true

	const homeNodeHash = normalizeHex64(joinContent.homeNodeHash || state.members?.[pk]?.homeNodeHash)
	if (isHex64(homeNodeHash) && state.bannedNodes?.has?.(homeNodeHash)) return true

	if (isHex64(homeNodeHash)) {
		const entityHash = `${homeNodeHash}${pk}`
		if (state.bannedEntities?.has?.(entityHash)) return true
	}
	return false
}

/**
 * 从成员行收集 unban 时应清除的键。
 * @param {object} state 物化群状态
 * @param {string} targetPubKeyHash 成员 pubKeyHash
 * @returns {{ pubKeyHash: string, entityHash: string|null, nodeHash: string|null }} 应清除的 ban 键
 */
export function unbanTargetsFromMember(state, targetPubKeyHash) {
	const pk = normalizeHex64(targetPubKeyHash)
	const member = state.members?.[pk]
	const homeNodeHash = normalizeHex64(member?.homeNodeHash)
	const entityHash = isHex64(pk) && isHex64(homeNodeHash) ? `${homeNodeHash}${pk}` : null
	return {
		pubKeyHash: pk,
		entityHash: entityHash && isEntityHash128(entityHash) ? entityHash : null,
		nodeHash: isHex64(homeNodeHash) ? homeNodeHash : null,
	}
}
