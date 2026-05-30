/**
 * 【文件】profile/profile.mjs
 * 【职责】实体（用户/agent）资料 CRUD：多 locale 切片、头像、在线状态、心跳与统计。
 * 【原理】entityHash 定位 replica 磁盘 profile.json；读取时合并 localized 与 persona 展示；可写 replica 校验 isWritableLocalEntity；头像存 entity avatars 目录。
 * 【数据结构】UserProfile、localized map、stats、effectiveStatus、profileAvatarUrl API 路径。
 * 【关联】被 profile/endpoints.mjs、actions.mjs、groupSync 调用；依赖 localized.mjs、personaPresentation.mjs、chat/lib/paths。
 */
import fs from 'node:fs'
import path from 'node:path'

import { loadJsonFile, saveJsonFile } from '../../../../../../scripts/json_loader.mjs'
import { getAllUserNames } from '../../../../../../server/auth.mjs'
import { parseEntityHash } from '../chat/lib/entityId.mjs'
import {
	entityAvatarsDir,
	entityDir,
	entityProfilePath,
	shellChatRoot,
} from '../chat/lib/paths.mjs'
import { getGroupMemberEntityHash, isWritableLocalEntity } from '../chat/lib/replica.mjs'

import {
	applyAvatarToAllLocales,
	getInfoDefaultsForEntity,
	normalizeLocalizedMap,
	resolveProfilePresentation,
} from './localized.mjs'
import {
	isPlaceholderDisplayName,
	resolvePersonaPresentation,
} from './personaPresentation.mjs'

const ENTITIES_API = '/api/parts/shells:chat/entities'

/**
 * @param {string} entityHash 128 位 entityHash
 * @returns {string} 头像 API URL
 */
export function profileAvatarUrl(entityHash) {
	return `${ENTITIES_API}/${encodeURIComponent(entityHash)}/avatar/file`
}

/**
 * @param {string} entityHash 128 位 entityHash
 * @returns {string | null} 托管该实体 profile 的 replica 登录名
 */
function findReplicaHostingEntity(entityHash) {
	const parsed = parseEntityHash(entityHash)
	if (!parsed) return null
	for (const replica of getAllUserNames())
		if (fs.existsSync(entityProfilePath(replica, parsed.entityHash)))
			return replica

	return null
}

/**
 * @param {string} entityHash 128 位 entityHash
 * @returns {string|null} 头像文件绝对路径
 */
export function resolveAvatarFilePath(entityHash) {
	const replica = findReplicaHostingEntity(entityHash)
	if (!replica) return null
	const avatarDir = entityAvatarsDir(replica, entityHash)
	if (!fs.existsSync(avatarDir)) return null
	const prefix = `${entityHash.slice(0, 16)}_`
	const files = fs.readdirSync(avatarDir)
		.filter(filename => filename.startsWith(prefix))
		.map(filename => ({
			filename,
			mtime: fs.statSync(path.join(avatarDir, filename)).mtimeMs,
		}))
		.sort((a, b) => b.mtime - a.mtime)
	if (!files.length) return null
	return path.join(avatarDir, files[0].filename)
}

/** @typedef {import('../../decl/chatAuxAPI.ts').UserProfile} UserProfile */
/** @typedef {import('../../decl/chatAuxAPI.ts').UserProfilePresentation} UserProfilePresentation */
/** @typedef {import('../../decl/chatAuxAPI.ts').UserStatus} UserStatus */

/** 超过该毫秒未心跳则视为离线 */
const HEARTBEAT_STALE_MS = 120_000

const MANUAL_STATUSES = new Set(['online', 'idle', 'dnd', 'invisible', 'away', 'busy', 'offline'])

/**
 * @param {string} entityHash 128 位 entityHash
 * @param {{ nodeHash: string, subjectHash: string }} parsed parseEntityHash 结果
 * @returns {UserProfile} 默认资料
 */
function getDefaultProfile(entityHash, parsed) {
	return {
		entityHash,
		nodeHash: parsed.nodeHash,
		subjectHash: parsed.subjectHash,
		localized: {},
		status: 'online',
		customStatus: '',
		lastSeenAt: 0,
		stats: {
			joinedAt: Date.now(),
			messageCount: 0,
			groupCount: 0,
			channelCount: 0,
		},
	}
}

/**
 * 从合并对象中剥离仅用于持久化的字段。
 * @param {object} raw 原始对象
 * @returns {UserProfile} 可写入磁盘的资料
 */
function toStoredProfile(raw) {
	return {
		entityHash: raw.entityHash,
		nodeHash: raw.nodeHash,
		subjectHash: raw.subjectHash,
		localized: normalizeLocalizedMap(raw.localized),
		status: raw.status || 'online',
		customStatus: String(raw.customStatus || '').trim(),
		lastSeenAt: raw.lastSeenAt || 0,
		stats: {
			joinedAt: raw.stats?.joinedAt || Date.now(),
			messageCount: raw.stats?.messageCount || 0,
			groupCount: raw.stats?.groupCount || 0,
			channelCount: raw.stats?.channelCount || 0,
		},
	}
}

/**
 * @param {object} profile 用户资料
 * @param {string} [viewerEntityHash] 查看者 entityHash
 * @param {{ isSelf?: boolean }} [options] isSelf 为 true 时隐身对本人可见
 * @returns {string} effectiveStatus
 */
export function computeEffectiveStatus(profile, viewerEntityHash, options = {}) {
	const stored = String(profile?.status || 'online')
	const isSelf = options.isSelf
		?? (viewerEntityHash && profile?.entityHash === viewerEntityHash)
	const lastSeen = profile?.lastSeenAt || 0
	const recentlySeen = lastSeen > 0 && Date.now() - lastSeen < HEARTBEAT_STALE_MS

	if (stored === 'invisible')
		return isSelf ? 'invisible' : 'offline'

	if (!recentlySeen)
		return 'offline'

	return stored
}

/**
 * @param {string} replicaUsername 写入 replica
 * @param {string} entityHash 128 位 entityHash
 * @param {{ groupId?: string, skipPresentation?: boolean, locales?: string[] }} [options] 群上下文与 locale
 * @returns {Promise<UserProfile | UserProfilePresentation>} 资料对象
 */
export async function getProfile(entityHash, replicaUsername = null, options = {}) {
	const parsed = parseEntityHash(entityHash)
	if (!parsed) throw new Error('invalid entityHash')

	const hostReplica = replicaUsername || findReplicaHostingEntity(parsed.entityHash)
	const profileFile = hostReplica ? entityProfilePath(hostReplica, parsed.entityHash) : null

	const defaultProfile = getDefaultProfile(parsed.entityHash, parsed)
	let stored = defaultProfile

	if (profileFile && fs.existsSync(profileFile))
		stored = toStoredProfile({ ...defaultProfile, ...await loadJsonFile(profileFile) })
	else if (hostReplica && isWritableLocalEntity(hostReplica, parsed.entityHash)) {
		fs.mkdirSync(entityDir(hostReplica, parsed.entityHash), { recursive: true })
		await saveJsonFile(entityProfilePath(hostReplica, parsed.entityHash), stored)
	}

	const locales = options.locales || ['zh-CN', 'en-UK']
	const merged = {
		...stored,
		entityHash: parsed.entityHash,
		nodeHash: parsed.nodeHash,
		subjectHash: parsed.subjectHash,
	}

	if (options.skipPresentation) return merged

	const infoDefaults = hostReplica
		? await getInfoDefaultsForEntity(hostReplica, parsed.entityHash, locales)
		: { name: `${parsed.subjectHash.slice(0, 8)}…${parsed.subjectHash.slice(-4)}`, avatar: '', description: '', description_markdown: '', version: '', author: '', home_page: '', issue_page: '', tags: [], links: [] }
	const resolved = resolveProfilePresentation(merged, locales, infoDefaults)
	return {
		...merged,
		...resolved,
		infoDefaults,
		localeKeys: Object.keys(merged.localized),
	}
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} entityHash 128 位 entityHash
 * @returns {Promise<void>}
 */
export async function recordHeartbeat(replicaUsername, entityHash) {
	const profile = await getProfile(entityHash, replicaUsername, { skipPresentation: true })
	profile.lastSeenAt = Date.now()
	await saveJsonFile(entityProfilePath(replicaUsername, entityHash), toStoredProfile(profile))
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} entityHash 128 位 entityHash
 * @param {Partial<UserProfile>} updates 更新内容
 * @param {{ groupId?: string, skipPresentation?: boolean, locales?: string[] }} [options] 群上下文
 * @returns {Promise<UserProfile | UserProfilePresentation>} 更新后的资料
 */
export async function updateProfile(replicaUsername, entityHash, updates, options = {}) {
	if (!isWritableLocalEntity(replicaUsername, entityHash))
		throw new Error('entity not writable on this replica')

	const profile = await getProfile(entityHash, replicaUsername, {
		groupId: options.groupId,
		skipPresentation: true,
	})
	const parsed = parseEntityHash(entityHash)

	const localized = updates.localized != null
		? normalizeLocalizedMap(updates.localized)
		: profile.localized

	const updatedProfile = toStoredProfile({
		...profile,
		entityHash: parsed.entityHash,
		nodeHash: parsed.nodeHash,
		subjectHash: parsed.subjectHash,
		localized,
		status: updates.status != null ? updates.status : profile.status,
		customStatus: updates.customStatus != null ? updates.customStatus : profile.customStatus,
		lastSeenAt: updates.lastSeenAt != null ? updates.lastSeenAt : profile.lastSeenAt,
		stats: updates.stats ? { ...profile.stats, ...updates.stats } : profile.stats,
	})

	await saveJsonFile(entityProfilePath(replicaUsername, entityHash), updatedProfile)
	if (options.skipPresentation) return updatedProfile
	const locales = options.locales || ['zh-CN', 'en-UK']
	const infoDefaults = await getInfoDefaultsForEntity(replicaUsername, entityHash, locales)
	const resolved = resolveProfilePresentation(updatedProfile, locales, infoDefaults)
	return { ...updatedProfile, ...resolved, infoDefaults, localeKeys: Object.keys(updatedProfile.localized) }
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} entityHash 128 位 entityHash
 * @param {Buffer} fileBuffer 文件缓冲区
 * @param {string} filename 文件名
 * @returns {Promise<string>} 头像 URL
 */
export async function uploadAvatar(replicaUsername, entityHash, fileBuffer, filename) {
	if (!isWritableLocalEntity(replicaUsername, entityHash))
		throw new Error('entity not writable on this replica')

	const avatarDir = entityAvatarsDir(replicaUsername, entityHash)
	if (!fs.existsSync(avatarDir))
		fs.mkdirSync(avatarDir, { recursive: true })

	const uniqueFilename = `${entityHash.slice(0, 16)}_${Date.now()}${path.extname(filename)}`
	fs.writeFileSync(path.join(avatarDir, uniqueFilename), fileBuffer)

	const avatarUrl = profileAvatarUrl(entityHash)
	const profile = await getProfile(entityHash, replicaUsername, { skipPresentation: true })
	await updateProfile(replicaUsername, entityHash, {
		localized: applyAvatarToAllLocales(profile.localized, avatarUrl),
	}, { skipPresentation: true })
	return avatarUrl
}

/**
 * @param {string} entityHash 128 位 entityHash
 * @returns {Promise<UserProfile['stats']>} 统计字段
 */
export async function getStats(entityHash) {
	const profile = await getProfile(entityHash)
	return profile.stats
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} entityHash 128 位 entityHash
 * @param {UserStatus} status 状态
 * @param {string} [customStatus] 自定义状态
 * @returns {Promise<void>}
 */
export async function updateStatus(replicaUsername, entityHash, status, customStatus = '') {
	if (!MANUAL_STATUSES.has(status))
		throw new Error('invalid status')
	await updateProfile(replicaUsername, entityHash, {
		status,
		customStatus,
		lastSeenAt: Date.now(),
	}, { skipPresentation: true })
}

/**
 * 确保本节点操作者实体目录存在（viewer 引导用）。
 * @param {string} replicaUsername replica 所有者
 * @param {string} entityHash 128 位 entityHash
 * @returns {Promise<UserProfile>} 本节点实体资料
 */
export async function ensureLocalEntityProfile(replicaUsername, entityHash) {
	if (!isWritableLocalEntity(replicaUsername, entityHash))
		throw new Error('entity not on local node')
	fs.mkdirSync(shellChatRoot(replicaUsername), { recursive: true })
	return getProfile(entityHash, replicaUsername, { skipPresentation: true })
}

/**
 * 用当前群 persona / part 默认写回 `localized`（仅填空）。
 * @param {string} replicaUsername replica 登录名
 * @param {string} groupId 群 ID
 * @returns {Promise<void>}
 */
export async function syncEntityProfileFromPersona(replicaUsername, groupId) {
	const entityHash = await getGroupMemberEntityHash(replicaUsername, groupId)
	if (!isWritableLocalEntity(replicaUsername, entityHash)) return
	const locales = ['zh-CN', 'en-UK']
	const presentation = await resolvePersonaPresentation(replicaUsername, groupId)
	const infoDefaults = await getInfoDefaultsForEntity(replicaUsername, entityHash, locales)
	const profile = await getProfile(entityHash, replicaUsername, { groupId, skipPresentation: true })
	const localized = normalizeLocalizedMap(profile.localized)
	const primary = locales[0]
	const slice = localized[primary] || {}
	let changed = false
	const next = { ...slice }
	if (!slice.name?.trim() || isPlaceholderDisplayName(slice.name.trim(), profile)) {
		next.name = presentation.displayName || infoDefaults.name
		changed = true
	}
	if (!slice.avatar?.trim() && !resolveAvatarFilePath(entityHash)) {
		next.avatar = presentation.avatar || infoDefaults.avatar
		changed = true
	}
	if (changed) {
		localized[primary] = next
		await updateProfile(replicaUsername, entityHash, { localized }, { groupId, skipPresentation: true })
	}
}
