import { authenticate, getUserByReq } from '../../../../../../server/auth.mjs'
import { assignShellData, loadShellData } from '../../../../../../server/setting_loader.mjs'
import { loadTrustedAuthorHashes, saveTrustedAuthorHashes } from '../../../../../../server/trustedAuthors.mjs'
import { addBlocklistEntry, loadBlocklist } from '../chat/governance/blocklist.mjs'

import { optionalChannelId } from './_shared.mjs'

/**
 * @param {import('npm:express').Router} router Express 路由
 * @returns {void}
 */
export function registerPrefsRoutes(router) {
	router.get('/api/parts/shells\\:chat/blocklist', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		res.status(200).json(loadBlocklist(username))
	})
	router.post('/api/parts/shells\\:chat/blocklist', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		const body = req.body || {}
		const scope = String(body.scope || 'subject').trim().toLowerCase()
		const value = String(body.value ?? '').trim()
		if (!value)
			return res.status(400).json({ error: 'value required' })
		await addBlocklistEntry(username, { scope, value, groupId: optionalChannelId(body.groupId) })
		res.status(200).json(loadBlocklist(username))
	})

	router.get('/api/parts/shells\\:chat/trusted-authors', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		res.status(200).json({ hashes: loadTrustedAuthorHashes(username) })
	})
	router.put('/api/parts/shells\\:chat/trusted-authors', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		const body = req.body || {}
		const hashes = saveTrustedAuthorHashes(username, body.hashes)
		res.status(200).json({ hashes })
	})

	router.get('/api/user/trusted-authors', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		res.status(200).json({ hashes: loadTrustedAuthorHashes(username) })
	})
	router.put('/api/user/trusted-authors', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		const body = req.body || {}
		const hashes = saveTrustedAuthorHashes(username, body.hashes)
		res.status(200).json({ hashes })
	})

	router.get('/api/parts/shells\\:chat/bookmarks', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		const raw = loadShellData(username, 'chat', 'bookmarks')
		res.status(200).json(Array.isArray(raw?.entries) ? raw.entries : [])
	})
	router.put('/api/parts/shells\\:chat/bookmarks', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		const body = req.body || {}
		assignShellData(username, 'chat', 'bookmarks', { entries: Array.isArray(body.entries) ? body.entries : [] })
		res.status(200).json({})
	})

	router.get('/api/parts/shells\\:chat/group-folders', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		const raw = loadShellData(username, 'chat', 'groupFolders')
		res.status(200).json({ folders: Array.isArray(raw?.folders) ? raw.folders : [] })
	})
	router.put('/api/parts/shells\\:chat/group-folders', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		const body = req.body || {}
		assignShellData(username, 'chat', 'groupFolders', { folders: Array.isArray(body.folders) ? body.folders : [] })
		res.status(200).json({})
	})

	router.get('/api/parts/shells\\:chat/custom-emojis', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		const raw = loadShellData(username, 'chat', 'customEmojis')
		res.status(200).json({ entries: Array.isArray(raw?.entries) ? raw.entries : [] })
	})
	router.put('/api/parts/shells\\:chat/custom-emojis', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
		const body = req.body || {}
		assignShellData(username, 'chat', 'customEmojis', { entries: Array.isArray(body.entries) ? body.entries : [] })
		res.status(200).json({ entries: Array.isArray(body.entries) ? body.entries : [] })
	})
	router.post('/api/parts/shells\\:chat/custom-emojis/save', authenticate, async (req, res) => {
		const { username } = getUserByReq(req)
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
		const { username } = getUserByReq(req)
		const { listFrequentEmojis } = await import('../emojiUsage.mjs')
		const limit = Math.min(64, Math.max(1, Number.parseInt(String(req.query?.limit ?? '32'), 10) || 32))
		res.status(200).json({ entries: listFrequentEmojis(username, limit) })
	})
}
