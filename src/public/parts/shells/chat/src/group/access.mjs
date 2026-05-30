/**
 * 【文件】group/access.mjs
 * 【职责】群成员身份解析与 RBAC 权限判定，供路由层与查询层复用。
 * 【原理】pubKeyHash/成员键双向匹配活跃成员；本机用户从 local_signer_seed 推导 pubKeyHash；频道权限委托 p2p hasPermission。
 * 【数据结构】物化 state（members、roles、channels、channelPermissions）、PERMISSIONS 常量。
 * 【关联】被 group/routes/*、queries.mjs、localAuthz.mjs 引用；依赖 chat/dag/materialize、chat/lib/paths。
 */
import { readFile } from 'node:fs/promises'

import { pubKeyHash, publicKeyFromSeed } from '../../../../../../scripts/p2p/crypto.mjs'
import { hasPermission, PERMISSIONS } from '../../../../../../scripts/p2p/permissions.mjs'
import { localSignerSeedPath } from '../chat/lib/paths.mjs'

/**
 * @param {object} state 物化群状态
 * @param {string} memberKey 成员键或 pubKeyHash（64 hex）
 * @returns {string | null} 活跃成员在 state.members 中的键，无则 null
 */
export function resolveActiveMemberKey(state, memberKey) {
	if (state.members[memberKey]?.status === 'active') return memberKey
	const lower = String(memberKey || '').toLowerCase()
	for (const [key, member] of Object.entries(state.members || {})) {
		if (member?.status !== 'active') continue
		if (member.pubKeyHash?.toLowerCase() === lower || key.toLowerCase() === lower) return key
	}
	return null
}

/**
 * 本机 replica：`getUserByReq` 登录名 + 该群 `local_signer_seed` 推导的 pubKeyHash。
 * @param {string} replicaUsername fount 登录名（仅用于 replica 磁盘路径）
 * @param {string} groupId 群 ID
 * @param {object} state 物化群状态
 * @returns {Promise<string | null>} 成员键
 */
export async function resolveActiveMemberKeyForLocalUser(replicaUsername, groupId, state) {
	try {
		const raw = await readFile(localSignerSeedPath(replicaUsername, groupId))
		if (raw.length < 32) return null
		const secretKey = new Uint8Array(raw.buffer, raw.byteOffset, 32)
		return resolveActiveMemberKey(state, pubKeyHash(publicKeyFromSeed(secretKey)))
	}
	catch {
		return null
	}
}

/**
 * @param {object} state 物化群状态
 * @param {string} identifier 成员键或 pubKeyHash（64 hex）
 * @returns {string | null} 成员在 state.members 中的键，无则 null
 */
export function resolveMemberKey(state, identifier) {
	if (state.members[identifier]) return identifier
	const lower = String(identifier || '').toLowerCase()
	for (const [key, member] of Object.entries(state.members || {})) 
		if (member?.pubKeyHash?.toLowerCase() === lower) return key
	
	return null
}

/**
 * @param {object} state 物化群状态
 * @param {string} username 成员键
 * @returns {boolean} 是否为活跃成员
 */
export function isActiveMember(state, username) {
	return resolveActiveMemberKey(state, username) != null
}

/**
 * @param {object} state 物化群状态
 * @param {object} member 成员记录
 * @param {string} permission 权限键
 * @param {string} channelId 频道 ID
 * @returns {boolean} 是否具备权限
 */
export function canInChannel(state, member, permission, channelId) {
	return hasPermission(member, permission, state.roles, channelId, state.channelPermissions)
}

/**
 * @param {object} state 物化群状态
 * @returns {string} 治理权限折叠用频道 id
 */
export function governanceChannelId(state) {
	const def = state.groupSettings?.defaultChannelId
	if (def && state.channels?.[def]) return def
	const keys = Object.keys(state.channels || {})
	return keys[0] || 'default'
}

/**
 * @param {object} state 物化群状态
 * @param {object} member 成员记录
 * @returns {boolean} 是否可签发 reputation_slash（治理频道 ADMIN 或 MANAGE_ROLES）
 */
export function canGovSlash(state, member) {
	const govCh = governanceChannelId(state)
	return canInChannel(state, member, PERMISSIONS.ADMIN, govCh)
		|| canInChannel(state, member, PERMISSIONS.MANAGE_ROLES, govCh)
}
