/**
 * 【文件】governance/blocklist.mjs
 * 【职责】用户级拉黑表（shellData）与群级 peers.blockedPeers 的增删查，判断 subject/entity/node 是否应拒绝联邦与 WS 交互。
 * 【原理】loadBlocklist 读 chat/blocklist；isSubjectBannedByState 合并物化 ban 与 peers 拉黑。addBlocklistEntry 可同时写 peers.json。fork 对立分支时 blockOpposingForkBranch 批量拉黑签发者。
 * 【数据结构】{ blocked: [{ scope, value, groupId? }] }；scope 为 subject|entity|node。
 * 【关联】peers.mjs、banRules.mjs、federation room 入站过滤、forkBlockOpposing.mjs。
 */
import { isHex64, normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { loadShellData, saveShellData } from '../../../../../../../server/setting_loader.mjs'
import { parseEntityHash } from '../lib/entityId.mjs'

import { addBlockedPeer } from './peers.mjs'

/** @typedef {'subject' | 'entity' | 'node'} BlockScope */

/**
 * @param {unknown} value entityHash
 * @returns {boolean} 是否为 128 位 entityHash
 */
function isEntityHash128Local(value) {
	return !!parseEntityHash(value)
}

/**
 * @param {unknown} raw 磁盘 JSON 或请求体
 * @returns {{ blocked: Array<{ scope: BlockScope, value: string, groupId?: string }> }} 规范化拉黑表
 */
export function normalizeBlocklist(raw) {
	const entries = Array.isArray(raw?.blocked) ? raw.blocked : []
	const blocked = []
	for (const entry of entries) {
		const scope = String(entry?.scope || 'subject').trim().toLowerCase()
		const groupId = String(entry.groupId || '').trim()
		/**
		 * @param {BlockScope} s 拉黑范围
		 * @param {string} value 键值
		 * @returns {void}
		 */
		const wrap = (s, value) => {
			if (!value) return
			blocked.push({ scope: s, value, ...groupId ? { groupId } : {} })
		}
		if (scope === 'entity') {
			const v = String(entry?.entityHash || entry?.value || '').trim().toLowerCase()
			if (isEntityHash128Local(v)) wrap('entity', v)
			continue
		}
		if (scope === 'node') {
			const v = normalizeHex64(entry?.nodeHash || entry?.value)
			if (isHex64(v)) wrap('node', v)
			continue
		}
		const hash = normalizeHex64(entry?.pubKeyHash || entry?.value)
		if (isHex64(hash)) wrap('subject', hash)
	}
	return { blocked }
}

/**
 * 读取用户级拉黑表（`shells/chat/blocklist`）。
 * @param {string} username replica 登录名
 * @returns {{ blocked: Array<{ scope: BlockScope, value: string, groupId?: string }> }} 用户级拉黑表
 */
export function loadBlocklist(username) {
	return normalizeBlocklist(loadShellData(username, 'chat', 'blocklist'))
}

/**
 * @param {object} state 物化群状态
 * @param {object} subject 待检主体
 * @param {string} [subject.pubKeyHash] 成员 subject hash
 * @param {string} [subject.entityHash] 128 位 entityHash
 * @param {string} [subject.nodeHash] 64 位 nodeHash
 * @returns {boolean} 是否命中群级 ban 集合
 */
export function isSubjectBannedByState(state, subject) {
	const pk = normalizeHex64(subject?.pubKeyHash)
	if (isHex64(pk) && state?.bannedMembers?.has?.(pk)) return true
	const entity = String(subject?.entityHash || '').trim().toLowerCase()
	if (isEntityHash128Local(entity) && state?.bannedEntities?.has?.(entity)) return true
	const node = normalizeHex64(subject?.nodeHash)
	if (isHex64(node) && state?.bannedNodes?.has?.(node)) return true
	return false
}

/**
 * @param {string} username replica 登录名
 * @param {object} subject 待检主体
 * @returns {boolean} 是否在用户级 blocklist 中
 */
export function isSubjectBlocked(username, subject) {
	const list = loadBlocklist(username).blocked
	const pk = normalizeHex64(subject?.pubKeyHash)
	const entity = String(subject?.entityHash || '').trim().toLowerCase()
	const node = normalizeHex64(subject?.nodeHash)
	for (const entry of list) {
		if (entry.scope === 'subject' && isHex64(pk) && entry.value === pk) return true
		if (entry.scope === 'entity' && entity && entry.value === entity) return true
		if (entry.scope === 'node' && isHex64(node) && entry.value === node) return true
	}
	return false
}

/**
 * @param {string} username replica 登录名
 * @param {string} pubKeyHash 64 hex
 * @returns {boolean} 是否拉黑该 subject
 */
export function isPubKeyHashBlocked(username, pubKeyHash) {
	return isSubjectBlocked(username, { pubKeyHash })
}

/**
 * 追加拉黑并落盘。
 * @param {string} username replica 登录名
 * @param {{ scope: BlockScope, value: string, groupId?: string }} entry 拉黑项
 * @returns {Promise<void>}
 */
export async function addBlocklistEntry(username, entry) {
	const scope = String(entry?.scope || '').trim().toLowerCase()
	const value = String(entry?.value || '').trim().toLowerCase()
	if (!scope || !value)
		throw new Error('scope and value required')
	if (scope === 'subject' && !isHex64(normalizeHex64(value)))
		throw new Error('invalid pubKeyHash')
	if (scope === 'entity' && !isEntityHash128Local(value))
		throw new Error('invalid entityHash')
	if (scope === 'node' && !isHex64(normalizeHex64(value)))
		throw new Error('invalid nodeHash')

	const store = /** @type {{ blocked?: Array<Record<string, string>> }} */
		loadShellData(username, 'chat', 'blocklist')
	if (!Array.isArray(store.blocked)) store.blocked = []
	const normValue = scope === 'node' || scope === 'subject' ? normalizeHex64(value) : value
	if (!store.blocked.some(row => row.scope === scope && row.value === normValue)) {
		const sourceGroupId = String(entry.groupId || '').trim()
		store.blocked.push(sourceGroupId
			? { scope, value: normValue, groupId: sourceGroupId }
			: { scope, value: normValue })
	}
	saveShellData(username, 'chat', 'blocklist')
	const sourceGroupId = String(entry.groupId || '').trim()
	if (sourceGroupId)
		await addBlockedPeer(username, sourceGroupId, normValue)
}

/**
 * 按 member_ban content 批量写入用户级拉黑与群 peers。
 * @param {string} username replica 登录名
 * @param {object} banContent member_ban content
 * @param {string} [groupId] 来源群
 * @returns {Promise<void>}
 */
export async function addBlocklistFromBanContent(username, banContent, groupId) {
	const scope = String(banContent?.banScope || 'entity').trim().toLowerCase()
	const sourceGroupId = String(groupId || '').trim()
	if (scope === 'entity' && banContent?.targetEntityHash)
		await addBlocklistEntry(username, { scope: 'entity', value: banContent.targetEntityHash, groupId: sourceGroupId })
	if (scope === 'node' && banContent?.targetNodeHash)
		await addBlocklistEntry(username, { scope: 'node', value: banContent.targetNodeHash, groupId: sourceGroupId })
	const pk = normalizeHex64(banContent?.targetPubKeyHash)
	if (isHex64(pk))
		await addBlocklistEntry(username, { scope: 'subject', value: pk, groupId: sourceGroupId })
}
