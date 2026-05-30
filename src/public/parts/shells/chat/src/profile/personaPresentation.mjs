/**
 * 【文件】profile/personaPresentation.mjs
 * 【职责】人格（persona）部件驱动的展示名与默认头像解析，以及 entityHash 占位短名判定。
 * 【原理】有 groupId 时优先读物化 session.personas；否则 getAnyDefaultPart(personas)；getPartDetails 取部件 info/avatar。
 * 【数据结构】displayName、DEFAULT_USER_AVATAR、session personas 映射、isPlaceholderDisplayName 布尔。
 * 【关联】被 localized.mjs、profile.mjs 调用；依赖 chat/session/dagSession、parts_loader。
 */
import { getUserByUsername } from '../../../../../../server/auth.mjs'
import { getAnyDefaultPart, getPartDetails } from '../../../../../../server/parts_loader.mjs'
import { getMaterializedSession } from '../chat/session/dagSession.mjs'

/** 无自定义头像时的默认用户图（与 chat 模板中的 person.svg 一致） */
export const DEFAULT_USER_AVATAR = 'https://api.iconify.design/line-md/person.svg'

/**
 * @param {string} displayName 展示名
 * @param {{ subjectHash?: string }} profile 资料对象
 * @returns {boolean} 是否为 entityHash 占位短名
 */
export function isPlaceholderDisplayName(displayName, profile) {
	const name = String(displayName || '').trim()
	if (!name) return true
	const subjectHash = String(profile?.subjectHash || '').trim().toLowerCase()
	if (!subjectHash || subjectHash.length < 12) return false
	const placeholder = `${subjectHash.slice(0, 8)}…${subjectHash.slice(-4)}`
	return name === placeholder
}

/**
 * @param {string} replicaUsername replica 登录名
 * @param {string} [groupId] 群 ID（用于读取该群的 session persona）
 * @returns {Promise<string | null>} 人格部件名
 */
export async function resolvePersonanameForReplica(replicaUsername, groupId) {
	if (groupId) 
		try {
			const session = await getMaterializedSession(replicaUsername, groupId)
			const fromSession = session.personas?.[replicaUsername]
			if (fromSession) return fromSession
		}
		catch {
			// 群尚未物化时回退默认人格
		}
	
	return getAnyDefaultPart(replicaUsername, 'personas') || null
}

/**
 * 解析当前 chat 下应展示的用户名与头像（persona → fount 用户名 → 默认图）。
 * @param {string} replicaUsername replica 登录名
 * @param {string} [groupId] 群 ID
 * @returns {Promise<{ displayName: string, avatar: string }>} 展示名与头像 URL
 */
export async function resolvePersonaPresentation(replicaUsername, groupId) {
	const loginName = getUserByUsername(replicaUsername)?.username || replicaUsername
	const personaname = await resolvePersonanameForReplica(replicaUsername, groupId)
	let personaName = ''
	let personaAvatar = ''
	if (personaname) {
		const { info } = await getPartDetails(replicaUsername, `personas/${personaname}`).catch(() => ({})) || {}
		personaName = String(info?.name || '').trim()
		personaAvatar = String(info?.avatar || '').trim()
	}
	return {
		displayName: personaName || loginName,
		avatar: personaAvatar || DEFAULT_USER_AVATAR,
	}
}
