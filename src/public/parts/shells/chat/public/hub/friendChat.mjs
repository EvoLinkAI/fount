/**
 * 【文件】public/hub/friendChat.mjs
 * 【职责】好友私聊入口：查找或创建 DM 群、绑定角色/用户、切换 Hub 到私聊布局并连接群组 WS。
 * 【原理】`enterFriendChat` 渲染活跃角色卡、调整侧栏高亮与 composer；`dispatchFriendChat` 处理列表点击；设置 `hubStore.privateGroup` 后加载默认频道消息，与群聊共用 `messages` 管道。
 * 【数据结构】hubStore（core/state）及本模块函数入参/返回值；详见 JSDoc。
 * 【关联】由 `hashNav.navigateFromHash` 在解析到好友绑定 groupId 时调用本模块；../../../../scripts/template、../../../../scripts/toast、../src/api/groupApi、../src/api/groupFriendBinding、../src/friendBinding、../src/lib/entityHash、../src/lib/pubKeyHex、charCard。
 */
import { mountTemplate } from '../../../../scripts/template.mjs'
import { showToastI18n } from '../../../../scripts/toast.mjs'
import { createDirectMessageByPubKeys, getFederationSettings, getGroupState } from '../src/api/groupApi.mjs'
import { setGroupFriendBinding } from '../src/api/groupFriendBinding.mjs'
import { buildCharFriendBinding, buildUserFriendBinding } from '../src/friendBinding.mjs'
import { isEntityHash128 } from '../src/lib/entityHash.mjs'
import { isHex64 } from '../src/lib/pubKeyHex.mjs'

import { getCharDetails, renderCharInfoCardActive } from './charCard.mjs'
import { escapeHtml } from './core/domUtils.mjs'
import { hubStore } from './core/state.mjs'
import { friendBindingForGroup } from './friendBindings.mjs'
import { closeGroupWebSocket, connectGroupWebSocket } from './groupStream.mjs'
import { loadGroups } from './serverBar.mjs'

/**
 * 查找已绑定该角色 entityHash 的好友群。
 * @param {import('../src/friendBinding.mjs').FriendBinding} binding 绑定
 * @returns {Promise<string|null>} 群 ID
 */
async function findExistingFriendGroup(binding) {
	await loadGroups()
	return hubStore.groups.find(g => g.friendBinding?.entityHash === binding.entityHash)?.groupId ?? null
}

/**
 * 确保群上已挂载角色 part。
 * @param {string} groupId 群 ID
 * @param {string} charname 角色名
 * @returns {Promise<void>}
 */
async function ensureCharOnGroup(groupId, charname) {
	const cr = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(groupId)}/chars`, { credentials: 'include' })
	if (!cr.ok) throw new Error(`HTTP ${cr.status}`)
	const chars = await cr.json()
	if (Array.isArray(chars) && chars.includes(charname)) return
	const add = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(groupId)}/char`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ charname }),
	})
	if (!add.ok) throw new Error(`HTTP ${add.status}`)
}

/**
 * 解析或新建好友群 ID（角色需 addchar；用户 DM 由调用方传入 groupId）。
 * @param {import('../src/friendBinding.mjs').FriendBinding} binding 绑定
 * @param {{ groupId?: string, forceNew?: boolean }} opts 选项
 * @returns {Promise<string|null>} 群 ID；失败为 null
 */
async function resolveFriendGroupId(binding, opts = {}) {
	let groupId = opts.forceNew ? undefined : opts.groupId
	if (groupId) {
		if (binding.charname)
			await ensureCharOnGroup(groupId, binding.charname)
		return groupId
	}
	if (!groupId && !opts.forceNew) {
		const hashRaw = window.location.hash.slice(1)
		if (hashRaw.startsWith('group:')) {
			const [id] = hashRaw.slice('group:'.length).split(':')
			if (id) groupId = id
		}
	}
	if (!groupId && !opts.forceNew)
		groupId = await findExistingFriendGroup(binding)

	if (!groupId) {
		const r = await fetch('/api/parts/shells:chat/groups', {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ friendBinding: binding }),
		})
		if (!r.ok) throw new Error(`HTTP ${r.status}`)
		groupId = (await r.json()).groupId
	}

	if (binding.charname)
		await ensureCharOnGroup(groupId, binding.charname)

	return groupId
}

/**
 * 进入好友私聊：与用户 DM 相同，走群频道 + 群 WS；角色回复由服务端按群 char 列表触发。
 * @param {string} groupId 群 ID
 * @param {import('../src/friendBinding.mjs').FriendBinding} binding 绑定
 * @returns {Promise<void>}
 */
async function openFriendGroupChat(groupId, binding) {
	closeGroupWebSocket()

	const state = await getGroupState(groupId)
	const channelId = state?.groupSettings?.defaultChannelId || 'default'
	const displayName = binding.displayName || binding.charname || state.groupMeta?.name || groupId

	hubStore.privateGroup.peerEntityHash = binding.entityHash
	hubStore.privateGroup.charName = binding.charname || null
	hubStore.privateGroup.groupId = groupId
	hubStore.privateGroup.channelId = channelId
	hubStore.currentGroupId = groupId
	hubStore.currentChannelId = channelId
	hubStore.currentState = state

	hubStore.privateGroup.onEnterPrivateGroup({
		entityHash: binding.entityHash,
		charname: binding.charname,
		displayName,
	})

	document.getElementById('hub-channel-name-display').textContent = displayName
	if (binding.charname) {
		const details = await getCharDetails(binding.charname)
		renderCharInfoCardActive(binding.charname, details)
	}
	else
		document.getElementById('hub-info-card-host').innerHTML = ''

	window.history.replaceState(null, '', `${location.pathname}${location.search}#group:${encodeURIComponent(groupId)}:${channelId}`)

	await setGroupFriendBinding(groupId, binding)
	await loadGroups()

	const { enableComposer, loadMessages } = await import('./messages/messages.mjs')
	enableComposer()
	const input = document.getElementById('hub-message-input')
	if (input)
		if (binding.charname) {
			input.dataset.name = binding.charname
			input.setAttribute('data-i18n', 'chat.hub.charChatComposer')
		}
		else {
			delete input.dataset.name
			input.setAttribute('data-i18n', 'chat.hub.friendChatComposer')
		}


	connectGroupWebSocket(groupId, channelId)
	await loadMessages()

	const { loadFriendsList, renderFriendsColumn } = await import('./friendsList.mjs')
	if (hubStore.currentMode === 'friends')
		await renderFriendsColumn(await loadFriendsList())
}

/**
 * @param {object} opts 选项
 * @param {string} [opts.groupId] 群 ID
 * @param {import('../src/friendBinding.mjs').FriendBinding} [opts.binding] 绑定
 * @param {boolean} [opts.forceNew] 强制新建群（仅角色）
 * @returns {Promise<void>}
 */
export async function enterFriendChat(opts = {}) {
	const binding = opts.binding || (opts.groupId ? friendBindingForGroup(opts.groupId) : null)
	if (!binding?.entityHash) return

	const { clearPrivateGroupState } = await import('./privateGroup.mjs')
	clearPrivateGroupState()
	await mountTemplate(document.getElementById('hub-messages'), 'hub/empty/loading', {})

	try {
		const groupId = await resolveFriendGroupId(binding, opts)
		if (!groupId) return
		await openFriendGroupChat(groupId, binding)
	}
	catch (error) {
		await mountTemplate(document.getElementById('hub-messages'), 'hub/empty/error', {
			i18nKey: 'chat.hub.createChatFailed',
			errorMessage: error.message,
			escapeHtml,
		})
	}
}

/**
 * @param {{ type: 'char' | 'user', id?: string, displayName?: string, pubKeyHex?: string | null, entityHash?: string | null }} entity 实体
 * @returns {Promise<void>}
 */
export async function dispatchFriendChat(entity) {
	if (entity.type === 'char' && entity.id) {
		const { nodeHash } = hubStore
		if (!nodeHash) {
			showToastI18n('error', 'chat.hub.noUsername')
			return
		}
		await enterFriendChat({
			binding: await buildCharFriendBinding(nodeHash, entity.id, entity.displayName),
		})
		return
	}
	if (entity.type !== 'user') return

	const fed = await getFederationSettings()
	const myPubKeyHex = String(fed?.identityPubKeyHex || '').trim().toLowerCase()
	if (!isHex64(myPubKeyHex)) {
		showToastI18n('warning', 'chat.hub.profilePopup.noFedIdentity')
		return
	}
	const peerHex = String(entity.pubKeyHex || '').trim().toLowerCase()
	if (!isHex64(peerHex) && !isEntityHash128(entity.entityHash)) {
		showToastI18n('warning', 'chat.hub.profilePopup.peerNoIdentity')
		return
	}
	const data = await createDirectMessageByPubKeys(myPubKeyHex, peerHex)
	const binding = friendBindingForGroup(data.groupId)
		|| await buildUserFriendBinding({
			entityHash: entity.entityHash,
			pubKeyHex: peerHex,
			displayName: entity.displayName,
		})
	await enterFriendChat({ groupId: data.groupId, binding })
}
