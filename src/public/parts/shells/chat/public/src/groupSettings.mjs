/**
 * 【文件】public/src/groupSettings.mjs
 * 【职责】群设置面板：频道列表、成员、治理、审计、表情、文件系统等 Tab 逻辑。
 * 【原理】initGroupSettings 挂载多模板；groupApi 读写；ensureAuditLogPanel 懒加载审计。
 * 【数据结构】当前 groupId、stateJson、各 Tab DOM 引用。
 * 【关联】auditLogPanel.mjs、groupApi、groupViewerPermissions；Hub 设置路由。
 */
import { confirmI18n, initTranslations, promptI18n } from '../../../../scripts/i18n.mjs'
import {
	mountTemplate,
	renderTemplateNoScriptActivation,
	usingTemplates,
} from '../../../../scripts/template.mjs'
import { showToastI18n } from '../../../../scripts/toast.mjs'
import { authorDisplayLabel, escapeHtml } from '../hub/core/domUtils.mjs'

import {
	createGroupInvite,
	postFederationTuning,
	rotateGroupKey,
	submitOwnerSuccession,
	unbanMember,
} from './api/groupApi.mjs'
import { disposeAuditLogPanel, initAuditLogPanel } from './auditLogPanel.mjs'
import { groupEmojiDataApiPath } from './groupEmojiApi.mjs'
import {
	fetchViewerChannelPermissions,
	viewerCanManageMessages,
	viewerCanOwnerSuccession,
} from './groupViewerPermissions.mjs'
let currentGroupId = null
let currentState = null
/** @type {object | null} */
let currentStateJson = null

let permissionsController = null
let membersController = null
/** @type {string} 最近一次签发邀请的剪贴板全文（服务端 locale） */
let lastInviteClipboardText = ''

let auditPanelReady = false
let channelPermsReady = false
let emojisPanelReady = false
let channelPermsController = null
/** @type {string | null} */
let selectedChannelPermsId = null

const ALL_PERMISSIONS = [
	'VIEW_CHANNEL', 'SEND_MESSAGES', 'SEND_STICKERS', 'ADD_REACTIONS',
	'MANAGE_MESSAGES', 'UPLOAD_FILES', 'PIN_MESSAGES', 'CREATE_THREADS',
	'MANAGE_CHANNELS', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_ROLES',
	'INVITE_MEMBERS', 'STREAM', 'MANAGE_FILES', 'ADMIN', 'BYPASS_RATE_LIMIT',
]

/**
 * @param {object} [entry] ICE 行
 * @returns {HTMLElement} 可编辑的 ICE 配置行
 */
function buildIceServerRow(entry = {}) {
	const urls = Array.isArray(entry.urls) ? entry.urls.join(', ') : String(entry.urls || '')
	const row = document.createElement('div')
	row.className = 'grid grid-cols-1 md:grid-cols-4 gap-2 items-end'
	row.dataset.iceRow = '1'
	row.innerHTML = `
		<input type="text" class="input input-bordered input-sm md:col-span-2" data-ice-url placeholder="stun:host:19302"
			value="${escapeHtml(urls)}">
		<input type="text" class="input input-bordered input-sm" data-ice-user placeholder="TURN user"
			value="${escapeHtml(String(entry.username || ''))}">
		<div class="flex gap-1">
			<input type="password" class="input input-bordered input-sm flex-1" data-ice-cred placeholder="credential"
				value="${escapeHtml(String(entry.credential || ''))}">
			<button type="button" class="btn btn-ghost btn-sm" data-ice-remove>×</button>
		</div>`
	row.querySelector('[data-ice-remove]')?.addEventListener('click', () => row.remove())
	return row
}

/** 挂载 ICE/TURN 行编辑器。 */
function wireIceServersEditor() {
	const host = document.getElementById('ice-servers-host')
	if (!host) return
	const list = Array.isArray(currentState?.groupSettings?.iceServers)
		? currentState.groupSettings.iceServers
		: [{ urls: 'stun:stun.l.google.com:19302' }]
	host.replaceChildren(...list.map(entry => buildIceServerRow(entry)))
	document.getElementById('ice-servers-add')?.addEventListener('click', () => {
		if (host.querySelectorAll('[data-ice-row]').length >= 8) return
		host.appendChild(buildIceServerRow({ urls: 'stun:' }))
	})
}

/**
 * @returns {object[]} 待写入 groupSettings 的 iceServers
 */
function collectIceServersFromDom() {
	const host = document.getElementById('ice-servers-host')
	if (!host) return []
	const out = []
	for (const row of host.querySelectorAll('[data-ice-row]')) {
		const urlsRaw = row.querySelector('[data-ice-url]')?.value?.trim()
		if (!urlsRaw) continue
		const urls = urlsRaw.includes(',')
			? urlsRaw.split(',').map(s => s.trim()).filter(Boolean)
			: urlsRaw
		const username = row.querySelector('[data-ice-user]')?.value?.trim()
		const credential = row.querySelector('[data-ice-cred]')?.value
		const entry = { urls }
		if (username) {
			entry.username = username
			entry.credential = credential || ''
		}
		out.push(entry)
		if (out.length >= 8) break
	}
	return out
}

/**
 * 从 `#settings:<groupId>` 解析群组 ID（与 hub `urlHash` 一致支持 encode）。
 * @returns {string | null} 群组 ID；hash 不匹配时为 null
 */
function parseSettingsGroupIdFromHash() {
	const hash = window.location.hash.slice(1)
	if (!hash.startsWith('settings:')) return null
	const raw = hash.slice('settings:'.length)
	try {
		return decodeURIComponent(raw)
	}
	catch {
		return raw
	}
}

/** 初始化群设置页，从 hash 读取群 ID 并加载数据。 */
export async function initGroupSettings() {
	await initTranslations('chat')
	usingTemplates('/parts/shells:chat/src/templates')
	const groupId = parseSettingsGroupIdFromHash()
	if (groupId) await loadGroupSettings(groupId)
}

/**
 * @param {string} groupId 群组 ID
 * @returns {Promise<void>}
 */
async function loadGroupSettings(groupId) {
	currentGroupId = groupId
	const response = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(groupId)}/state`, { credentials: 'include' })
	const data = await response.json()
	if (!response.ok) throw new Error(data.error)
	auditPanelReady = false
	channelPermsReady = false
	emojisPanelReady = false
	disposeAuditLogPanel()
	currentState = data.state
	currentStateJson = data
	await renderGroupSettings()
	await renderPermissionSettings()
	await renderMembers()
	await updateAuditTabVisibility()
}

/**
 * 管理员可见时显示审计日志标签并支持懒加载面板。
 * @returns {Promise<void>}
 */
export async function updateAuditTabVisibility() {
	const tab = document.querySelector('.tabs .tab[data-tab="audit"]')
	if (!tab || !currentGroupId || !currentStateJson) return
	const canAdmin = await viewerCanOwnerSuccession(currentState, currentGroupId)
	tab.classList.toggle('hidden', !canAdmin)
}

/**
 * 首次打开审计标签时加载日志面板。
 * @returns {Promise<void>}
 */
export async function ensureAuditLogPanel() {
	if (!currentGroupId || auditPanelReady) return
	auditPanelReady = true
	await initAuditLogPanel(currentGroupId)
}

/** 首次打开表情标签时加载群表情管理面板。 */
export async function ensureGroupEmojisPanel() {
	if (!currentGroupId || emojisPanelReady) return
	emojisPanelReady = true
	await renderGroupEmojis()
}

/** 渲染群自定义表情管理面板。 */
async function renderGroupEmojis() {
	const container = document.getElementById('group-emojis-container')
	if (!container || !currentGroupId) return
	const channelId = currentState?.groupSettings?.defaultChannelId || 'default'
	const canManage = await viewerCanManageMessages(currentState, currentGroupId, channelId)
	const resp = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/emojis`, {
		credentials: 'include',
	})
	const data = await resp.json()
	const entries = Array.isArray(data.entries) ? data.entries : []
	const entriesHtml = entries.map(entry => {
		const src = groupEmojiDataApiPath(currentGroupId, entry.emojiId)
		const del = canManage
			? `<button type="button" class="btn btn-ghost btn-xs text-error" data-delete-emoji="${escapeHtml(entry.emojiId)}">×</button>`
			: ''
		return `<div class="flex flex-col items-center gap-1 p-2 rounded-lg bg-base-300">
<img src="${src}" alt="${escapeHtml(entry.name || entry.emojiId)}" class="w-12 h-12 object-contain" loading="lazy" />
<span class="text-xs truncate max-w-full">${escapeHtml(entry.name || entry.emojiId)}</span>
${del}
</div>`
	}).join('')
	await mountTemplate(container, 'group/settings/emojis_panel', {
		canManage,
		entriesHtml,
		entriesEmpty: !entries.length,
	})
	const upload = document.getElementById('group-emoji-upload')
	if (upload) 
		upload.addEventListener('change', async () => {
			const file = upload.files?.[0]
			if (!file) return
			const form = new FormData()
			form.append('emoji', file)
			form.append('name', file.name.replace(/\.[^.]+$/, ''))
			const up = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/emojis`, {
				method: 'POST',
				credentials: 'include',
				body: form,
			})
			const upData = await up.json()
			if (!up.ok) {
				showToastI18n('error', 'chat.group.settingsPage.emojisUploadFailed', { error: upData.error || up.statusText })
				return
			}
			showToastI18n('success', 'chat.group.settingsPage.emojisUploadOk')
			emojisPanelReady = false
			await ensureGroupEmojisPanel()
		})
	
	container.querySelectorAll('[data-delete-emoji]').forEach(deleteEmojiButton => {
		deleteEmojiButton.addEventListener('click', async () => {
			const emojiId = deleteEmojiButton.getAttribute('data-delete-emoji')
			if (!emojiId || !confirmI18n('chat.group.settingsPage.emojisDeleteConfirm')) return
			const del = await fetch(
				`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/emojis/${encodeURIComponent(emojiId)}`,
				{ method: 'DELETE', credentials: 'include' },
			)
			const delData = await del.json()
			if (!del.ok) {
				showToastI18n('error', 'chat.group.settingsPage.emojisDeleteFailed', { error: delData.error || '' })
				return
			}
			showToastI18n('success', 'chat.group.settingsPage.emojisDeleteOk')
			emojisPanelReady = false
			await ensureGroupEmojisPanel()
		})
	})
}

/**
 * @param {object} stateJson state API 载荷
 * @param {string} groupId 群 ID
 * @returns {Promise<boolean>} 是否可执行 key-rotate（DM 双方或 ADMIN）
 */
/**
 * @param {Response} response HTTP 响应
 * @returns {Promise<string>} 错误文案
 */
async function readApiError(response) {
	const text = await response.text()
	try {
		const data = JSON.parse(text)
		return String(data.error || data.message || text)
	}
	catch {
		return text || `HTTP ${response.status}`
	}
}

/**
 * @param {object} stateJson state API 载荷
 * @param {string} groupId 群 ID
 * @returns {Promise<boolean>} 是否可执行 key-rotate（DM 双方或 ADMIN）
 */
async function viewerCanKeyRotate(stateJson, groupId) {
	const memberCount = Number(stateJson?.memberCount)
		|| Object.keys(stateJson?.members || {}).length
	if (memberCount === 2) return true
	const channelId = stateJson?.groupSettings?.defaultChannelId
		|| Object.keys(stateJson?.channels || {})[0]
		|| 'default'
	const permissions = await fetchViewerChannelPermissions(stateJson, groupId, channelId)
	return permissions.ADMIN === true
}

/**
 * 是否可编辑联邦调优（ADMIN / MANAGE_ADMINS）。
 * @param {object} stateJson state API 载荷
 * @param {string} groupId 群 ID
 * @returns {Promise<boolean>} 是否可编辑联邦调优
 */
async function viewerCanFedTuning(stateJson, groupId) {
	const channelId = stateJson?.groupSettings?.defaultChannelId
		|| Object.keys(stateJson?.channels || {})[0]
		|| 'default'
	const permissions = await fetchViewerChannelPermissions(stateJson, groupId, channelId)
	return permissions.ADMIN === true || permissions.MANAGE_ADMINS === true
}

/** 渲染基本信息与设置表单。 */
async function renderGroupSettings() {
	const container = document.getElementById('group-settings-container')
	if (!container) return

	const showKeyRotate = await viewerCanKeyRotate(currentState, currentGroupId)
	const showOwnerSuccession = await viewerCanOwnerSuccession(currentState, currentGroupId)
	const showFedTuning = await viewerCanFedTuning(currentState, currentGroupId)

	await mountTemplate(container, 'group/settings/basic_panel', {
		currentState,
		escapeHtml,
		showKeyRotate,
		showFedTuning,
		showOwnerSuccession,
	})

	wireIceServersEditor()
	document.getElementById('save-group-settings').addEventListener('click', saveGroupSettings)
	document.getElementById('group-settings-delete-group-button').addEventListener('click', deleteGroup)
	document.getElementById('group-settings-key-rotate-button')?.addEventListener('click', async () => {
		if (!currentGroupId || !confirmI18n('chat.group.settingsPage.keyRotateConfirm')) return
		try {
			await rotateGroupKey(currentGroupId)
			showToastI18n('success', 'chat.group.settingsPage.keyRotateOk')
			await loadGroupSettings(currentGroupId)
		}
		catch (error) {
			showToastI18n('error', 'chat.group.settingsPage.keyRotateFailed', { error: error.message })
		}
	})
	document.getElementById('group-settings-owner-succession-button')?.addEventListener('click', () => {
		void showOwnerSuccessionModal()
	})
	document.getElementById('group-settings-mint-invite-button').addEventListener('click', async () => {
		if (!currentGroupId) return
		const button = document.getElementById('group-settings-mint-invite-button')
		button.disabled = true
		try {
			const { code, expiresAt, clipboardText } = await createGroupInvite(currentGroupId)
			lastInviteClipboardText = clipboardText || ''
			document.getElementById('group-settings-invite-group-id').textContent = currentGroupId
			document.getElementById('invite-code').textContent = code
			const expEl = document.getElementById('invite-exp')
			expEl.dataset.date = new Date(expiresAt).toLocaleString()
			expEl.dataset.i18n = 'chat.group.settingsPage.inviteExpires'
			document.getElementById('invite-result').classList.remove('hidden')
		}
		catch (error) {
			showToastI18n('error', 'chat.group.settingsPage.saveFailed', { error: error.message })
		}
		finally {
			button.disabled = false
		}
	})
	document.getElementById('group-settings-copy-invite-button').addEventListener('click', async () => {
		try {
			if (!lastInviteClipboardText)
				throw new Error('no invite clipboard text')
			await navigator.clipboard.writeText(lastInviteClipboardText)
			showToastI18n('success', 'chat.group.settingsPage.inviteCopied')
		}
		catch {
			showToastI18n('error', 'chat.group.settingsPage.inviteCopyFailed')
		}
	})
}


/**
 * @param {Record<string, boolean>} allow 允许覆写
 * @param {Record<string, boolean>} deny 拒绝覆写
 * @param {string} perm 权限常量名
 * @returns {'neutral' | 'allow' | 'deny'} 三态
 */
function channelPermTriState(allow, deny, perm) {
	if (deny?.[perm]) return 'deny'
	if (allow?.[perm]) return 'allow'
	return 'neutral'
}

/**
 * @param {string} channelId 频道 ID
 * @returns {Promise<Record<string, { allow?: Record<string, boolean>, deny?: Record<string, boolean> }>>} 角色覆写表
 */
async function fetchChannelPermissions(channelId) {
	const resp = await fetch(
		`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/channels/${encodeURIComponent(channelId)}/permissions`,
		{ credentials: 'include' },
	)
	const data = await resp.json()
	if (!resp.ok) throw new Error(data.error || resp.statusText)
	return data.permissions || {}
}

/**
 * @param {string} channelId 频道 ID
 * @param {string} roleId 角色 ID
 * @param {Record<string, boolean>} allow 允许覆写
 * @param {Record<string, boolean>} deny 拒绝覆写
 * @returns {Promise<void>}
 */
async function putChannelPermissions(channelId, roleId, allow, deny) {
	const resp = await fetch(
		`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/channels/${encodeURIComponent(channelId)}/permissions`,
		{
			method: 'PUT',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ roleId, allow, deny }),
		},
	)
	const data = await resp.json()
	if (!resp.ok) throw new Error(data.error || resp.statusText)
}

/** 渲染频道级角色权限覆盖面板。 */
async function renderChannelPermissionsPanel() {
	const container = document.getElementById('channel-perms-container')
	if (!container || !currentGroupId || !currentState) return

	channelPermsController?.abort()
	channelPermsController = new AbortController()
	const { signal } = channelPermsController

	const channels = Object.entries(currentState.channels || {})
		.filter(([, ch]) => ch?.type === 'text' || ch?.type === 'list')
		.map(([id, ch]) => ({ id, name: ch?.name || id }))
	if (!channels.length) {
		await mountTemplate(container, 'group/settings/channel_permissions_panel', { channels: [] })
		return
	}
	if (!selectedChannelPermsId || !channels.some(ch => ch.id === selectedChannelPermsId))
		selectedChannelPermsId = channels[0].id

	let permissions = {}
	try {
		permissions = await fetchChannelPermissions(selectedChannelPermsId)
	}
	catch (error) {
		showToastI18n('error', 'chat.group.settingsPage.channelPermsUpdateFailed', { error: error.message })
	}

	const overrideRoleIds = Object.keys(permissions)
	const rolePanels = overrideRoleIds.map(roleId => {
		const role = currentState.roles[roleId] || { name: roleId, color: '#888' }
		const allow = permissions[roleId]?.allow || {}
		const deny = permissions[roleId]?.deny || {}
		return {
			roleId,
			name: role.name || roleId,
			color: role.color || '#888',
			permRows: ALL_PERMISSIONS.map(perm => ({
				perm,
				state: channelPermTriState(allow, deny, perm),
			})),
		}
	})
	const addableRoles = Object.entries(currentState.roles || {})
		.filter(([roleId]) => !overrideRoleIds.includes(roleId))
		.map(([id, role]) => ({ id, name: role?.name || id }))

	await mountTemplate(container, 'group/settings/channel_permissions_panel', {
		channels,
		selectedChannelId: selectedChannelPermsId,
		rolePanels,
		addableRoles,
		escapeHtml,
	})

	container.addEventListener('click', async event => {
		const selectCh = event.target.closest('[data-action="select-channel"]')
		if (selectCh) {
			selectedChannelPermsId = selectCh.dataset.channelId || null
			await renderChannelPermissionsPanel()
			return
		}
		const addRoleOverrideButton = event.target.closest('[data-action="add-role-override"]')
		if (addRoleOverrideButton) {
			const sel = document.getElementById('channel-perms-add-role')
			const roleId = sel instanceof HTMLSelectElement ? sel.value : ''
			if (!roleId || !selectedChannelPermsId) return
			try {
				await putChannelPermissions(selectedChannelPermsId, roleId, {}, {})
				showToastI18n('success', 'chat.group.settingsPage.channelPermsUpdated')
				await renderChannelPermissionsPanel()
			}
			catch (error) {
				showToastI18n('error', 'chat.group.settingsPage.channelPermsUpdateFailed', { error: error.message })
			}
			return
		}
		const removeRoleOverrideButton = event.target.closest('[data-action="remove-role-override"]')
		if (removeRoleOverrideButton?.dataset.roleId && selectedChannelPermsId) {
			try {
				await putChannelPermissions(selectedChannelPermsId, removeRoleOverrideButton.dataset.roleId, {}, {})
				showToastI18n('success', 'chat.group.settingsPage.channelPermsUpdated')
				await renderChannelPermissionsPanel()
			}
			catch (error) {
				showToastI18n('error', 'chat.group.settingsPage.channelPermsUpdateFailed', { error: error.message })
			}
			return
		}
		const channelPermStateButton = event.target.closest('[data-action="channel-perm-state"]')
		if (!channelPermStateButton || !selectedChannelPermsId) return
		const group = channelPermStateButton.closest('[data-role-id][data-perm]')
		if (!group) return
		const roleId = group.getAttribute('data-role-id')
		const perm = group.getAttribute('data-perm')
		const nextState = channelPermStateButton.getAttribute('data-state')
		if (!roleId || !perm || !nextState) return
		const current = await fetchChannelPermissions(selectedChannelPermsId)
		const allow = { ...current[roleId]?.allow || {} }
		const deny = { ...current[roleId]?.deny || {} }
		delete allow[perm]
		delete deny[perm]
		if (nextState === 'allow') allow[perm] = true
		else if (nextState === 'deny') deny[perm] = true
		try {
			await putChannelPermissions(selectedChannelPermsId, roleId, allow, deny)
			showToastI18n('success', 'chat.group.settingsPage.channelPermsUpdated')
			await renderChannelPermissionsPanel()
		}
		catch (error) {
			showToastI18n('error', 'chat.group.settingsPage.channelPermsUpdateFailed', { error: error.message })
		}
	}, { signal })
}

/** 首次打开频道权限标签时加载面板。 */
export async function ensureChannelPermissionsPanel() {
	if (!currentGroupId || channelPermsReady) return
	channelPermsReady = true
	await renderChannelPermissionsPanel()
}

/** 渲染角色与权限设置面板。 */
async function renderPermissionSettings() {
	const container = document.getElementById('permission-settings-container')
	if (!container) return

	permissionsController?.abort()
	permissionsController = new AbortController()
	const { signal } = permissionsController

	await mountTemplate(container, 'group/settings/permissions_panel', {
		currentState,
		allPermissions: ALL_PERMISSIONS,
		escapeHtml,
	})

	document.getElementById('group-settings-create-role-button').addEventListener('click', showCreateRoleModal, { signal })
	container.addEventListener('change', async event => {
		const checkbox = event.target.closest('[data-action="update-permission"]')
		if (checkbox) await updateRolePermission(checkbox.dataset.roleId, checkbox.dataset.perm, checkbox.checked)
	}, { signal })
	container.addEventListener('click', async (clickEvent) => {
		const deleteRoleButton = clickEvent.target.closest('[data-action="delete-role"]')
		if (deleteRoleButton) await deleteRole(deleteRoleButton.dataset.roleId)
	}, { signal })
}


/** 渲染活跃成员列表。 */
async function renderMembers() {
	const container = document.getElementById('members-list')
	if (!container) return

	membersController?.abort()
	membersController = new AbortController()
	const { signal } = membersController

	const memberRows = Array.isArray(currentState.members) ? currentState.members : []
	const members = memberRows.map(member => {
		const pubKeyHash = member.pubKeyHash || ''
		const roles = member.roles || ['@everyone']
		const displayName = String(member.displayName || '').trim()
			|| authorDisplayLabel(member.entityHash || pubKeyHash)
		return {
			pubKeyHash: escapeHtml(pubKeyHash),
			displayName: escapeHtml(displayName),
			initial: escapeHtml(displayName.charAt(0).toUpperCase() || '?'),
			rolesLabel: escapeHtml(roles.map(roleId => currentState.roles[roleId]?.name || roleId).join(' / ') || '@everyone'),
			isAdmin: roles.includes('admin'),
		}
	})

	const bannedRows = Array.isArray(currentState.bannedMembers) ? currentState.bannedMembers : []
	const bannedMembers = bannedRows.map(member => ({
		pubKeyHash: escapeHtml(member.pubKeyHash || ''),
	}))

	await mountTemplate(container, 'group/settings/members_list', { members, bannedMembers })

	container.addEventListener('click', async (clickEvent) => {
		const memberActionButton = clickEvent.target.closest('[data-action="kick"],[data-action="ban"],[data-action="unban"]')
		if (!memberActionButton) return
		if (memberActionButton.dataset.action === 'kick') await kickMember(memberActionButton.dataset.username)
		else if (memberActionButton.dataset.action === 'ban') await banMember(memberActionButton.dataset.username)
		else await unbanMemberAction(memberActionButton.dataset.username)
	}, { signal })
}

/** 弹出群主继任模态；联署由服务端用本机群签名种子完成。 */
async function showOwnerSuccessionModal() {
	if (!currentGroupId) return
	usingTemplates('/parts/shells:chat/src/templates')
	const viewerPubKeyHash = String(currentStateJson?.viewerMemberPubKeyHash || '').trim().toLowerCase()
	const modal = document.createElement('dialog')
	modal.className = 'modal'
	modal.appendChild(await renderTemplateNoScriptActivation('group/modals/owner_succession', {
		viewerPubKeyHash: escapeHtml(viewerPubKeyHash),
	}))
	document.body.appendChild(modal)
	modal.showModal()
	const input = modal.querySelector('[data-owner-pubkey-input]')
	const submitButton = modal.querySelector('[data-owner-succ-submit]')
	/**
	 *
	 */
	const closeModal = () => {
		modal.close()
		modal.remove()
	}
	modal.querySelector('[data-owner-succ-self]')?.addEventListener('click', () => {
		if (input instanceof HTMLInputElement && viewerPubKeyHash)
			input.value = viewerPubKeyHash
	})
	modal.querySelector('[data-owner-succ-cancel]')?.addEventListener('click', closeModal)
	modal.querySelector('[data-owner-succ-submit]')?.addEventListener('click', async () => {
		const proposedOwnerPubKeyHash = input instanceof HTMLInputElement ? input.value.trim().toLowerCase() : ''
		if (!proposedOwnerPubKeyHash) {
			showToastI18n('warning', 'chat.group.ownerSuccessionNeedHash')
			return
		}
		if (submitButton instanceof HTMLButtonElement) submitButton.disabled = true
		try {
			await submitOwnerSuccession(currentGroupId, {
				proposedOwnerPubKeyHash,
				ballotId: crypto.randomUUID(),
			})
			showToastI18n('success', 'chat.group.settingsPage.ownerSuccessionOk')
			closeModal()
			await loadGroupSettings(currentGroupId)
		}
		catch (error) {
			showToastI18n('error', 'chat.group.settingsPage.ownerSuccessionFailed', { error: error.message })
		}
		finally {
			if (submitButton instanceof HTMLButtonElement) submitButton.disabled = false
		}
	})
	modal.addEventListener('close', () => modal.remove())
}


/** 保存群基本信息与设置。 */
async function saveGroupSettings() {
	const metaResponse = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/meta`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({
			name: document.getElementById('group-name').value.trim(),
			description: document.getElementById('group-description').value.trim(),
		})
	})
	if (!metaResponse.ok) throw new Error(await readApiError(metaResponse))

	const gossipTtl = Number.parseInt(document.getElementById('gossip-ttl').value, 10)
	const settingsResponse = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/settings`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({
			joinPolicy: document.getElementById('join-policy').value,
			powDifficulty: Number.parseInt(document.getElementById('pow-difficulty').value, 10) || 4,
			streamGeneratingIdleMs: Number.parseInt(document.getElementById('stream-generating-idle-ms').value, 10) || 150000,
			autoReplyFrequency: Math.max(0, Number.parseInt(document.getElementById('auto-reply-frequency')?.value, 10) || 0),
			maxDagPayloadBytes: Number.parseInt(document.getElementById('max-dag-payload-bytes').value, 10) || 262144,
			batterySaver: !!document.getElementById('battery-saver')?.checked,
			trustedPeerSlots: Number.parseInt(document.getElementById('trusted-peer-slots')?.value, 10) || 8,
			explorePeerSlots: Number.parseInt(document.getElementById('explore-peer-slots')?.value, 10) || 4,
			maxPeers: Number.parseInt(document.getElementById('max-peers')?.value, 10) || 24,
			gossipTtl: Number.isFinite(gossipTtl) ? gossipTtl : 2,
			wantIdsBudget: Number.parseInt(document.getElementById('want-ids-budget')?.value, 10) || 16,
			hlcMaxSkewMs: Number.parseInt(document.getElementById('hlc-max-skew-ms')?.value, 10) || 3_600_000,
			streamingSfuWss: document.getElementById('streaming-sfu-wss')?.value?.trim() || null,
			message_content_retention_ms: Number.parseInt(
				document.getElementById('message-content-retention-ms')?.value,
				10,
			) || 0,
			event_retention_depth: Number.parseInt(document.getElementById('event-retention-depth')?.value, 10) || 200_000,
			event_retention_ms: Number.parseInt(document.getElementById('event-retention-ms')?.value, 10) || 0,
			compactTriggerEventDepth: Number.parseInt(document.getElementById('compact-trigger-event-depth')?.value, 10) || 100_000,
			messageRateLimitPerMin: Math.max(1, Math.min(120,
				Number.parseInt(document.getElementById('message-rate-limit-per-min')?.value, 10) || 10)),
			iceServers: collectIceServersFromDom(),
			discoveryPublic: !!document.getElementById('discovery-public')?.checked,
			discoveryTitle: document.getElementById('discovery-title')?.value?.trim() || null,
			discoveryBlurb: document.getElementById('discovery-blurb')?.value?.trim() || null,
			autoChannelGc: !!document.getElementById('auto-channel-gc')?.checked,
		})
	})
	if (!settingsResponse.ok) throw new Error(await readApiError(settingsResponse))

	const partitionEl = document.getElementById('federation-partition-count')
	if (partitionEl) {
		/** @type {{ federationPartitionCount?: number, rtcConnectionBudgetMax?: number, rtcJoinRatePerMin?: number }} */
		const tuningPatch = {}
		const partitionCount = Number.parseInt(partitionEl.value, 10)
		if (Number.isFinite(partitionCount))
			tuningPatch.federationPartitionCount = partitionCount
		const rtcBudget = Number.parseInt(
			document.getElementById('rtc-connection-budget-max')?.value,
			10,
		)
		if (Number.isFinite(rtcBudget))
			tuningPatch.rtcConnectionBudgetMax = rtcBudget
		const rtcJoinRate = Number.parseInt(
			document.getElementById('rtc-join-rate-per-min')?.value,
			10,
		)
		if (Number.isFinite(rtcJoinRate))
			tuningPatch.rtcJoinRatePerMin = rtcJoinRate
		if (Object.keys(tuningPatch).length)
			await postFederationTuning(currentGroupId, tuningPatch)
	}

	showToastI18n('success', 'chat.group.settingsPage.saveSuccess')
	await loadGroupSettings(currentGroupId)
}

/** 确认后删除当前群并跳转首页。 */
async function deleteGroup() {
	if (!confirmI18n('chat.group.settingsPage.deleteConfirm')) return
	const resp = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}`, {
		method: 'DELETE',
		credentials: 'include'
	})
	const data = await resp.json()
	if (!resp.ok) throw new Error(data.error)
	showToastI18n('success', 'chat.group.settingsPage.deleteSuccess')
	window.location.href = '/parts/shells:chat/hub/'
}

/**
 * @param {string} roleId 角色 ID
 * @param {string} permission 权限常量
 * @param {boolean} enabled 是否启用
 * @returns {Promise<void>}
 */
async function updateRolePermission(roleId, permission, enabled) {
	const resp = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/roles/${encodeURIComponent(roleId)}/permissions`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ permission, enabled })
	})
	if (!resp.ok) {
		showToastI18n('error', 'chat.group.settingsPage.permissionUpdateFailed', { error: resp.statusText })
		await loadGroupSettings(currentGroupId)
		return
	}
	showToastI18n('success', 'chat.group.settingsPage.permissionUpdated')
}

/**
 * @param {string} roleId 角色 ID
 * @returns {Promise<void>}
 */
async function deleteRole(roleId) {
	if (!confirmI18n('chat.group.settingsPage.deleteRoleConfirm')) return
	const resp = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/roles/${encodeURIComponent(roleId)}`, {
		method: 'DELETE',
		credentials: 'include'
	})
	if (!resp.ok) throw new Error(resp.statusText)
	showToastI18n('success', 'chat.group.settingsPage.deleteRoleSuccess')
	await loadGroupSettings(currentGroupId)
}

/** 弹出 prompt 获取角色名后创建新角色。 */
function showCreateRoleModal() {
	const name = promptI18n('chat.group.settingsPage.createRolePrompt')
	if (!name?.trim()) return

	fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/roles`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ name: name.trim() })
	}).then(r => r.json().then(async data => {
		if (r.ok) {
			showToastI18n('success', 'chat.group.settingsPage.createRoleSuccess')
			await loadGroupSettings(currentGroupId)
		} else
			showToastI18n('error', 'chat.group.settingsPage.createRoleFailed', { error: data.error || '' })
	})).catch(error => showToastI18n('error', 'chat.group.settingsPage.createRoleFailed', { error: error.message }))
}

/**
 * @param {string} username 成员 pubKeyHash
 * @returns {Promise<void>}
 */
async function kickMember(username) {
	const viewerKey = String(currentState?.viewerMemberPubKeyHash || '').toLowerCase()
	if (viewerKey && username.toLowerCase() === viewerKey) 
		if (!confirmI18n('chat.group.settingsPage.kickSelfNodeWarning', { name: username })) return
	
	if (!confirmI18n('chat.group.settingsPage.kickConfirm', { name: username })) return
	const resp = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(currentGroupId)}/members/${encodeURIComponent(username)}/kick`, {
		method: 'POST',
		credentials: 'include'
	})
	if (!resp.ok) throw new Error(resp.statusText)
	showToastI18n('success', 'chat.group.settingsPage.kickSuccess')
	await loadGroupSettings(currentGroupId)
}

/**
 * @param {string} username 成员 pubKeyHash
 * @returns {Promise<void>}
 */
async function banMember(username) {
	const { pickBanScope } = await import('../hub/banScopePicker.mjs')
	const picked = await pickBanScope({ displayName: username })
	if (!picked) return
	try {
		const { banMemberWithScope } = await import('./api/groupBan.mjs')
		await banMemberWithScope(currentGroupId, username, picked)
		showToastI18n('success', 'chat.group.settingsPage.banSuccess')
		await loadGroupSettings(currentGroupId)
	}
	catch (error) {
		showToastI18n('error', 'chat.group.settingsPage.banFailed', { error: error.message })
	}
}

/**
 * @param {string} username 成员 pubKeyHash
 * @returns {Promise<void>}
 */
async function unbanMemberAction(username) {
	if (!confirmI18n('chat.group.settingsPage.unbanConfirm', { name: username })) return
	try {
		await unbanMember(currentGroupId, username)
		showToastI18n('success', 'chat.group.settingsPage.unbanSuccess')
		await loadGroupSettings(currentGroupId)
	}
	catch (error) {
		showToastI18n('error', 'chat.group.settingsPage.unbanFailed', { error: error.message })
	}
}
