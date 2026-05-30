/**
 * 【文件】src/endpoints.mjs
 * 【职责】chat shell 的 HTTP/WebSocket 路由注册中心，覆盖用户偏好、联邦设置、群会话 CRUD、附件与实时信令等对外 API。
 * 【原理】setEndpoints(router) 在 authenticate 之后挂路由：REST 读写 shellData（blocklist/bookmarks/custom-emojis 等）；群相关路由经 registerGroupRuntime 与 DAG materialize 校验成员；WS `/groups/:ownerNodeHash/:groupId` 将 UI socket 注册到 wsLifecycle，消息帧依次走控制帧、WebRTC 中继、身份握手、groupWsHub RPC；AV relay WS 单独校验频道存在后注册 avRelay。
 * 【数据结构】groupMetadatas（内存群 owner）、resolveGroupChannel 解析 channelId、optionalChannelId、req.files 上传缓冲、wire JSON 帧（parseInboundJson）。
 * 【关联】被 main.mjs Load 调用；聚合 chat/session、chat/stream、group、profile、stickers、files 等子模块端点。
 */
import { access } from 'node:fs/promises'


import { isHex64, normalizeHex64 } from '../../../../../scripts/p2p/hexIds.mjs'
import { authenticate, getUserByReq } from '../../../../../server/auth.mjs'
import { assignShellData, loadShellData } from '../../../../../server/setting_loader.mjs'

import { getDefaultChannelId } from './chat/dag/queries.mjs'
import { setDmIntroNonce } from './chat/dm/intro.mjs'
import { addBlocklistEntry, loadBlocklist } from './chat/governance/blocklist.mjs'
import { groupDir } from './chat/lib/paths.mjs'
import { parseInboundJson } from './chat/lib/wireIngress.mjs'
import { getWorldName } from './chat/session/channelWorld.mjs'
import {
	copyGroupChat,
	deleteGroup,
	exportGroupChat,
	getInitialData,
	importGroupChat,
	listGroupSessions,
} from './chat/session/crud.mjs'
import {
	addchar,
	addplugin,
	getCharListOfGroup,
	getPluginListOfGroup,
	getUserPersonaName,
	removechar,
	removeplugin,
	setCharSpeakingFrequency,
	setPersona,
	setWorld,
} from './chat/session/partConfig.mjs'
import { getGroupRuntime, registerGroupRuntime } from './chat/session/runtime.mjs'
import {
	groupMetadatas,
	handleClientWsControlFrame,
	registerGroupUiSocket,
	relayClientWebRtcSignal,
} from './chat/session/wsLifecycle.mjs'
import { registerAvRelaySocket } from './chat/stream/avRelay.mjs'
import {
	handleGroupSocketIdentityMessage,
	handleGroupSocketRpcMessage,
} from './chat/stream/groupWsHub.mjs'
import { addFile, getFile } from './files.mjs'
import { setEndpoints as registerProfileRoutesUnderChat } from './profile/endpoints.mjs'
import { setEndpoints as registerStickerRoutesUnderChat } from './stickers/endpoints.mjs'

/**
 * @param {string} groupId 群组 ID
 * @param {string | undefined} channelId 显式频道；缺省时取群默认频道
 * @param {string} replicaUsername replica 所有者
 * @returns {Promise<string>} 有效频道 ID
 */
async function resolveGroupChannel(groupId, channelId, replicaUsername) {
	const meta = await getGroupRuntime(groupId, replicaUsername)
	if (channelId) return channelId
	return getDefaultChannelId(replicaUsername, groupId)
}

/**
 * @param {unknown} value query/body 中的频道 id
 * @returns {string | undefined} 非空 trimmed 字符串，否则 undefined
 */
function optionalChannelId(value) {
	return value?.trim() || undefined
}

/**
 * 为聊天功能设置API端点。
 *
 * @param {import('npm:websocket-express').Router} router - Express路由实例，用于附加端点。
 */
export function setEndpoints(router) {
	registerProfileRoutesUnderChat(router, '/api/parts/shells:chat/entities')
	registerStickerRoutesUnderChat(router, '/api/parts/shells:chat/stickers')

	router.get('/api/parts/shells\\:chat/blocklist', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		res.status(200).json(loadBlocklist(username))
	})
	router.post('/api/parts/shells\\:chat/blocklist', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const body = req.body || {}
		const scope = String(body.scope || 'subject').trim().toLowerCase()
		const value = String(body.value ?? '').trim()
		if (!value)
			return res.status(400).json({ error: 'value required' })
		await addBlocklistEntry(username, { scope, value, groupId: optionalChannelId(body.groupId) })
		res.status(200).json(loadBlocklist(username))
	})

	router.get('/api/parts/shells\\:chat/trusted-authors', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const raw = loadShellData(username, 'chat', 'trustedAuthors')
		res.status(200).json({ hashes: Array.isArray(raw?.hashes) ? raw.hashes : [] })
	})
	router.put('/api/parts/shells\\:chat/trusted-authors', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const body = req.body || {}
		const hashes = Array.isArray(body.hashes)
			? body.hashes.map(hash => String(hash).trim().toLowerCase()).filter(isHex64)
			: []
		assignShellData(username, 'chat', 'trustedAuthors', { hashes: [...new Set(hashes)] })
		res.status(200).json({ hashes })
	})

	router.get('/api/parts/shells\\:chat/discovery', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { queryDiscoveryIndex } = await import('./chat/discovery/index.mjs')
		const limit = Number(req.query.limit) || 50
		const entries = await queryDiscoveryIndex(username, { limit })
		res.status(200).json({ entries })
	})

	router.post('/api/parts/shells\\:chat/discovery/refresh', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { publishDiscoveryAnnounceAllGroups } = await import('./chat/federation/discoveryRelay.mjs')
		const { requireDagDeps } = await import('./chat/federation/deps.mjs')
		const { nodeId } = requireDagDeps()
		await publishDiscoveryAnnounceAllGroups(username, nodeId)
		res.status(200).json({})
	})

	router.get('/api/parts/shells\\:chat/mailbox/summary', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { countMailboxPending } = await import('./chat/mailbox/store.mjs')
		res.status(200).json({ pending: await countMailboxPending(username) })
	})

	router.get('/api/parts/shells\\:chat/bookmarks', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const raw = loadShellData(username, 'chat', 'bookmarks')
		res.status(200).json(Array.isArray(raw?.entries) ? raw.entries : [])
	})
	router.put('/api/parts/shells\\:chat/bookmarks', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const body = req.body || {}
		assignShellData(username, 'chat', 'bookmarks', { entries: Array.isArray(body.entries) ? body.entries : [] })
		res.status(200).json({})
	})

	router.get('/api/parts/shells\\:chat/group-folders', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const raw = loadShellData(username, 'chat', 'groupFolders')
		res.status(200).json({ folders: Array.isArray(raw?.folders) ? raw.folders : [] })
	})
	router.put('/api/parts/shells\\:chat/group-folders', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const body = req.body || {}
		assignShellData(username, 'chat', 'groupFolders', { folders: Array.isArray(body.folders) ? body.folders : [] })
		res.status(200).json({})
	})

	router.get('/api/parts/shells\\:chat/custom-emojis', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const raw = loadShellData(username, 'chat', 'customEmojis')
		res.status(200).json({ entries: Array.isArray(raw?.entries) ? raw.entries : [] })
	})
	router.put('/api/parts/shells\\:chat/custom-emojis', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const body = req.body || {}
		assignShellData(username, 'chat', 'customEmojis', { entries: Array.isArray(body.entries) ? body.entries : [] })
		res.status(200).json({ entries: Array.isArray(body.entries) ? body.entries : [] })
	})
	router.post('/api/parts/shells\\:chat/custom-emojis/save', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const body = req.body || {}
		const groupId = String(body.groupId || '').trim()
		const emojiId = String(body.emojiId || '').trim()
		const dataUrl = String(body.dataUrl || '').trim()
		if (!groupId || !emojiId)
			return res.status(400).json({ error: 'groupId and emojiId required' })
		if (!dataUrl.startsWith('data:'))
			return res.status(400).json({ error: 'dataUrl required (data:…)' })
		const raw = loadShellData(username, 'chat', 'customEmojis')
		const entries = Array.isArray(raw?.entries) ? [...raw.entries] : []
		const id = `${groupId}/${emojiId}`
		const next = { id, groupId, emojiId, dataUrl, savedAt: Date.now() }
		const existingIndex = entries.findIndex(e => e?.id === id)
		if (existingIndex >= 0) entries[existingIndex] = next
		else entries.push(next)
		assignShellData(username, 'chat', 'customEmojis', { entries })
		res.status(200).json({ entry: next })
	})

	router.get('/api/parts/shells\\:chat/emoji-usage/frequent', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { listFrequentEmojis } = await import('./emojiUsage.mjs')
		const limit = Math.min(64, Math.max(1, Number.parseInt(String(req.query?.limit ?? '32'), 10) || 32))
		res.status(200).json({ entries: listFrequentEmojis(username, limit) })
	})

	router.get('/api/parts/shells\\:chat/federation-settings', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { ensureFederationDefaults } = await import('./chat/federation/config.mjs')
		const settings = ensureFederationDefaults(username)
		res.status(200).json(settings)
	})

	router.put('/api/parts/shells\\:chat/federation-settings', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const body = req.body || {}
		const { saveFederationSettings } = await import('./chat/federation/config.mjs')
		const patch = {}
		if (body.batterySaver != null) patch.batterySaver = !!body.batterySaver
		if (Array.isArray(body.relayUrls)) patch.relayUrls = body.relayUrls
		const dmIntroNonce = String(body.dmIntroNonce || '').trim()
		if (dmIntroNonce.length >= 16) setDmIntroNonce(username, dmIntroNonce)
		const identityPubKeyHex = String(body.identityPubKeyHex || '').trim().toLowerCase().replace(/^0x/iu, '')
		if (isHex64(identityPubKeyHex)) patch.identityPubKeyHex = identityPubKeyHex
		const settings = saveFederationSettings(username, patch)
		res.status(200).json(settings)
	})

	router.ws('/ws/parts/shells\\:chat/av-relay/:roomId', authenticate, async (ws, req) => {
		const { roomId } = req.params
		if (!roomId) return void ws.close()
		const colon = roomId.indexOf(':')
		if (colon < 1) return void ws.close()
		const groupId = roomId.slice(0, colon)
		const channelId = roomId.slice(colon + 1)
		if (!groupId || !channelId) return void ws.close()
		try {
			const { username } = await getUserByReq(req)
			const { getState } = await import('./chat/dag/materialize.mjs')
			const { resolveActiveMemberKeyForLocalUser } = await import('./group/access.mjs')
			const { state } = await getState(username, groupId)
			if (!await resolveActiveMemberKeyForLocalUser(username, groupId, state)) return void ws.close()
			if (!state.channels[channelId]) return void ws.close()
			registerAvRelaySocket(roomId, ws)
		}
		catch {
			ws.close()
		}
	})

	router.ws('/ws/parts/shells\\:chat/groups/:ownerNodeHash/:groupId', authenticate, async (ws, req) => {
		const { ownerNodeHash, groupId } = req.params
		if (!ownerNodeHash || !groupId) return void ws.close()
		try {
			const { username } = await getUserByReq(req)
			const { getLocalNodeHash } = await import('./chat/lib/replica.mjs')
			if (normalizeHex64(ownerNodeHash) !== getLocalNodeHash()) return void ws.close()
			const { getState } = await import('./chat/dag/materialize.mjs')
			const { resolveActiveMemberKeyForLocalUser } = await import('./group/access.mjs')
			const { groupWsRoomKey } = await import('./chat/stream/groupWsRooms.mjs')
			const { state } = await getState(username, groupId)
			if (!await resolveActiveMemberKeyForLocalUser(username, groupId, state)) return void ws.close()
			const roomKey = groupWsRoomKey(ownerNodeHash, groupId)
			registerGroupUiSocket(username, groupId, ws)
			ws.on('message', raw => {
				const wireMessage = parseInboundJson(raw)
				if (!wireMessage) return
				if (handleClientWsControlFrame(wireMessage)) return
				if (relayClientWebRtcSignal(roomKey, wireMessage)) return
				if (handleGroupSocketIdentityMessage(ws, wireMessage)) return
				void handleGroupSocketRpcMessage(roomKey, ws, wireMessage)
			})
		}
		catch {
			ws.close()
		}
	})

	router.get('/api/parts/shells\\:chat/groups/:groupId/initial-data', authenticate, async (req, res) => {
		const { groupId } = req.params
		const { username } = await getUserByReq(req)
		const meta = groupMetadatas.get(groupId)
		if (meta && meta.username !== username)
			return res.status(403).json({ error: 'Forbidden' })
		res.status(200).json(await getInitialData(groupId))
	})

	router.get('/api/parts/shells\\:chat/groups/:groupId/chars', authenticate, async (req, res) => {
		const { groupId } = req.params
		const { username } = await getUserByReq(req)
		await registerGroupRuntime(groupId, username)
		res.status(200).json(await getCharListOfGroup(groupId, username))
	})

	router.get('/api/parts/shells\\:chat/groups/:groupId/plugins', authenticate, async (req, res) => {
		const { groupId } = req.params
		const { username } = await getUserByReq(req)
		res.status(200).json(await getPluginListOfGroup(groupId, username))
	})

	router.get('/api/parts/shells\\:chat/groups/:groupId/persona', authenticate, async (req, res) => {
		const { groupId } = req.params
		const { username } = await getUserByReq(req)
		res.status(200).json(await getUserPersonaName(groupId, username))
	})

	router.get('/api/parts/shells\\:chat/groups/:groupId/world', authenticate, async (req, res) => {
		const { groupId } = req.params
		const { username } = await getUserByReq(req)
		const channelId = await resolveGroupChannel(groupId, optionalChannelId(req.query.channelId), username)
		res.status(200).json(await getWorldName(groupId, channelId))
	})

	router.put('/api/parts/shells\\:chat/groups/:groupId/char/:charname/frequency', authenticate, async (req, res) => {
		const { params: { groupId, charname }, body: { frequency } } = req
		const { username } = await getUserByReq(req)
		await setCharSpeakingFrequency(groupId, charname, frequency, username)
		res.status(200).json({})
	})

	router.put('/api/parts/shells\\:chat/groups/:groupId/world', authenticate, async (req, res) => {
		const { params: { groupId }, body: { worldname, channelId: requestedChannelId } } = req
		const { username } = await getUserByReq(req)
		const channelId = await resolveGroupChannel(groupId, optionalChannelId(requestedChannelId), username)
		await setWorld(groupId, channelId, worldname, username)
		res.status(200).json({})
	})

	router.put('/api/parts/shells\\:chat/groups/:groupId/persona', authenticate, async (req, res) => {
		const { params: { groupId }, body: { personaname } } = req
		const { username } = await getUserByReq(req)
		await setPersona(groupId, personaname, username)
		res.status(200).json({})
	})

	router.post('/api/parts/shells\\:chat/groups/:groupId/char', authenticate, async (req, res) => {
		const { params: { groupId }, body: { charname } } = req
		const { username } = await getUserByReq(req)
		await addchar(groupId, charname, username)
		res.status(200).json({})
	})

	router.delete('/api/parts/shells\\:chat/groups/:groupId/char/:charname', authenticate, async (req, res) => {
		const { groupId, charname } = req.params
		await removechar(groupId, charname)
		res.status(200).json({})
	})

	router.post('/api/parts/shells\\:chat/groups/:groupId/plugin', authenticate, async (req, res) => {
		const { params: { groupId }, body: { pluginname } } = req
		await addplugin(groupId, pluginname)
		res.status(200).json({})
	})

	router.delete('/api/parts/shells\\:chat/groups/:groupId/plugin/:pluginname', authenticate, async (req, res) => {
		const { groupId, pluginname } = req.params
		await removeplugin(groupId, pluginname)
		res.status(200).json({})
	})

	router.get('/api/parts/shells\\:chat/sessions/list', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		res.status(200).json(await listGroupSessions(username))
	})

	router.delete('/api/parts/shells\\:chat/sessions/:groupId', authenticate, async (req, res) => {
		const { groupId } = req.params
		const { username } = await getUserByReq(req)
		const owner = groupMetadatas.get(groupId)?.username
		if (owner && owner !== username)
			return res.status(403).json({ error: 'Permission denied' })
		try {
			await access(groupDir(username, groupId))
		}
		catch {
			return res.status(404).json({ error: 'Group not found' })
		}
		const [result] = await deleteGroup([groupId], username)
		if (result?.error)
			return res.status(500).json({ error: result.error })
		res.status(200).json({})
	})

	router.get('/api/parts/shells\\:chat/groups/:groupId/export', authenticate, async (req, res) => {
		const { groupId } = req.params
		const { username } = await getUserByReq(req)
		const owner = groupMetadatas.get(groupId)?.username
		if (owner && owner !== username)
			return res.status(403).json({ error: 'Permission denied' })
		try {
			await access(groupDir(username, groupId))
		}
		catch {
			return res.status(404).json({ error: 'Group not found' })
		}
		res.status(200).json(await exportGroupChat(groupId))
	})

	router.post('/api/parts/shells\\:chat/groups/import', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		res.status(200).json(await importGroupChat(req.body, username))
	})

	router.post('/api/parts/shells\\:chat/groups/:groupId/copy', authenticate, async (req, res) => {
		const { groupId } = req.params
		const { username } = await getUserByReq(req)
		const owner = groupMetadatas.get(groupId)?.username
		if (owner && owner !== username)
			return res.status(403).json({ error: 'Permission denied' })
		try {
			await access(groupDir(username, groupId))
		}
		catch {
			return res.status(404).json({ error: 'Group not found' })
		}
		res.status(200).json(await copyGroupChat(groupId, username))
	})

	router.post('/api/parts/shells\\:chat/attachments', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const hashes = []
		for (const file of Object.values(req.files || {}))
			hashes.push(await addFile(username, file.data))
		res.status(200).json({ hashes })
	})

	router.get(/^\/api\/parts\/shells:chat\/attachments\/([\da-f]+)$/i, authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		res.status(200).send(getFile(username, req.params[0]))
	})

}
