/**
 * 【文件】profile/endpoints.mjs
 * 【职责】实体资料 REST 与 viewer 端点：按 entityHash 读写 profile、头像、状态与心跳。
 * 【原理】setEndpoints 挂 /entities/:entityHash 与 /viewer；鉴权后 getReplicaFromReq；群上下文可切换 viewerEntityHash；写操作限制本机可写实体。
 * 【数据结构】128 位 entityHash 路径段、profile JSON、effectiveStatus、multipart avatar。
 * 【关联】被 chat/src/endpoints.mjs 调用；依赖 profile.mjs、localized.mjs、chat/lib/replica.mjs。
 */
import { authenticate } from '../../../../../../server/auth.mjs'
import { betterSendFile } from '../../../../../../server/web_server/resources.mjs'
import { isEntityHash128 } from '../chat/lib/entityId.mjs'
import {
	getGroupMemberEntityHash,
	getReplicaFromReq,
	isWritableLocalEntity,
	resolveOperatorEntityHash,
} from '../chat/lib/replica.mjs'
import { isAllowedImageUpload, pickUploadedFile } from '../upload/fromRequest.mjs'

import { localesFromRequest } from './localized.mjs'
import {
	computeEffectiveStatus,
	ensureLocalEntityProfile,
	getProfile,
	getStats,
	recordHeartbeat,
	resolveAvatarFilePath,
	updateProfile,
	updateStatus,
	uploadAvatar,
} from './profile.mjs'

const DEFAULT_ENTITIES_API = '/api/parts/shells:chat/entities'
const ENTITY_HASH_SEGMENT = '[\\da-f]{128}'

/**
 * @param {string} apiBase API 前缀
 * @param {string} tail 路径尾部（以 `/` 开头）
 * @returns {RegExp} 路径正则
 */
function entityPathRegex(apiBase, tail) {
	return new RegExp(`^${apiBase.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}/(${ENTITY_HASH_SEGMENT})${tail}`, 'i')
}

/**
 * 实体资料 REST（用户与 agent 统一；路径仅用 entityHash）。
 * @param {import('npm:websocket-express').Router} router Express 路由
 * @param {string} [apiBase=/api/parts/shells:chat/entities] API 前缀
 * @returns {void}
 */
export function setEndpoints(router, apiBase = DEFAULT_ENTITIES_API) {
	router.get('/api/parts/shells\\:chat/viewer', authenticate, async (req, res) => {
		const { replicaUsername, nodeHash } = await getReplicaFromReq(req)
		const { ensureFederationDefaults } = await import('../chat/federation/config.mjs')
		ensureFederationDefaults(replicaUsername)
		const operatorEntityHash = resolveOperatorEntityHash(replicaUsername)
		if (!operatorEntityHash)
			return res.status(200).json({ nodeHash,
				viewerEntityHash: null,
				profile: null,
				identityRequired: true,
			})
		
		const groupId = String(req.query?.groupId || '').trim() || undefined
		const locales = localesFromRequest(req, replicaUsername)
		let viewerEntityHash = operatorEntityHash
		if (groupId) 
			try {
				viewerEntityHash = await getGroupMemberEntityHash(replicaUsername, groupId)
			}
			catch {
				viewerEntityHash = operatorEntityHash
			}
		
		await ensureLocalEntityProfile(replicaUsername, viewerEntityHash)
		const profile = await getProfile(viewerEntityHash, replicaUsername, { groupId, locales })
		res.status(200).json({ nodeHash,
			viewerEntityHash,
			profile,
		})
	})

	router.get(entityPathRegex(apiBase, '/stats$'), authenticate, async (req, res) => {
		const entityHash = req.params[0].toLowerCase()
		if (!isEntityHash128(entityHash))
			return res.status(400).json({ error: 'invalid entityHash' })
		const { operatorEntityHash } = await getReplicaFromReq(req)
		const profile = await getProfile(entityHash)
		res.status(200).json({ stats: await getStats(entityHash) })
	})

	router.post(entityPathRegex(apiBase, '/heartbeat$'), authenticate, async (req, res) => {
		const entityHash = req.params[0].toLowerCase()
		const { replicaUsername } = await getReplicaFromReq(req)
		if (!isWritableLocalEntity(replicaUsername, entityHash))
			return res.status(403).json({ error: 'Permission denied' })
		await recordHeartbeat(replicaUsername, entityHash)
		res.status(200).json({})
	})

	router.post(entityPathRegex(apiBase, '/status$'), authenticate, async (req, res) => {
		const entityHash = req.params[0].toLowerCase()
		const { replicaUsername } = await getReplicaFromReq(req)
		if (!isWritableLocalEntity(replicaUsername, entityHash))
			return res.status(403).json({ error: 'Permission denied' })
		await updateStatus(replicaUsername, entityHash, req.body.status, req.body.customStatus)
		res.status(200).json({})
	})

	router.get(entityPathRegex(apiBase, '/avatar/file$'), authenticate, async (req, res) => {
		const entityHash = req.params[0].toLowerCase()
		const filePath = resolveAvatarFilePath(entityHash)
		if (!filePath) return res.status(404).end()
		return betterSendFile(res, filePath)
	})

	router.post(entityPathRegex(apiBase, '/avatar$'), authenticate, async (req, res) => {
		const entityHash = req.params[0].toLowerCase()
		const { replicaUsername } = await getReplicaFromReq(req)
		if (!isWritableLocalEntity(replicaUsername, entityHash))
			return res.status(403).json({ error: 'Permission denied' })
		const file = pickUploadedFile(req, 'avatar')
		if (!file)
			return res.status(400).json({ error: 'No file uploaded' })
		if (!isAllowedImageUpload(file))
			return res.status(400).json({ error: 'Only image files are allowed' })
		res.status(200).json({ avatarUrl: await uploadAvatar(replicaUsername, entityHash, file.buffer, file.originalname),
		})
	})

	router.get(entityPathRegex(apiBase, '$'), authenticate, async (req, res) => {
		const entityHash = req.params[0].toLowerCase()
		const { replicaUsername, operatorEntityHash } = await getReplicaFromReq(req)
		const groupId = String(req.query?.groupId || '').trim() || undefined
		const locales = localesFromRequest(req, replicaUsername)
		const profile = await getProfile(entityHash, replicaUsername, { groupId, locales })
		let groupMemberEntityHash = null
		if (groupId) 
			try {
				groupMemberEntityHash = await getGroupMemberEntityHash(replicaUsername, groupId)
			}
			catch { /* 非成员或未物化 */ }
		
		const isSelf = entityHash === operatorEntityHash
			|| (groupMemberEntityHash && entityHash === groupMemberEntityHash)
		profile.effectiveStatus = computeEffectiveStatus(profile, operatorEntityHash, { isSelf })
		res.status(200).json({ profile })
	})

	router.put(entityPathRegex(apiBase, '$'), authenticate, async (req, res) => {
		const entityHash = req.params[0].toLowerCase()
		const { replicaUsername } = await getReplicaFromReq(req)
		if (!isWritableLocalEntity(replicaUsername, entityHash))
			return res.status(403).json({ error: 'Permission denied' })
		const groupId = String(req.body?.groupId || req.query?.groupId || '').trim() || undefined
		const locales = localesFromRequest(req, replicaUsername)
		res.status(200).json({ profile: await updateProfile(replicaUsername, entityHash, req.body, { groupId, locales }),
		})
	})
}
