/**
 * 【文件】public/hub/groupContextMenu.mjs
 * 【职责】群组侧栏项与顶栏群组菜单：离开群、邀请、联邦入口、文件夹操作等上下文动作。
 * 【原理】`showGroupContextMenu` / `showGroupHeaderMenu` 弹出单例菜单层并处理 dismiss；离开或删除群后清空消息区；本模块不渲染气泡。
 * 【数据结构】hubStore（core/state）及本模块函数入参/返回值；详见 JSDoc。
 * 【关联】../../../../scripts/i18n、../../../../scripts/parts、../../../../scripts/template、../../../../scripts/toast、../src/api/groupApi、../src/inviteQr、chat、core/domUtils。
 */
import { confirmI18n } from '../../../../scripts/i18n.mjs'
import { getPartList } from '../../../../scripts/parts.mjs'
import {
	renderTemplate,
	renderTemplateAsHtmlString,
} from '../../../../scripts/template.mjs'
import { showToastI18n } from '../../../../scripts/toast.mjs'
import { createGroupInvite, groupRequest, leaveGroup } from '../src/api/groupApi.mjs'
import { buildInviteJoinShareUrl } from '../src/inviteQr.mjs'

import { clearPrivateGroupState } from './privateGroup.mjs'
import { escapeHtml } from './core/domUtils.mjs'
import { hubStore } from './core/state.mjs'
import { navigateToGroupSettings, selectGroup } from './groupNav.mjs'
import { closeGroupWebSocket } from './groupStream.mjs'
import { renderServerBar } from './serverBar.mjs'

/** @type {HTMLElement | null} */
let openMenuEl = null

/** 关闭已打开的群操作菜单。 @returns {void} */
export function dismissGroupActionMenu() {
	if (!openMenuEl) return
	openMenuEl.remove()
	openMenuEl = null
}

/**
 * 在指定坐标展示群操作菜单（设置、邀请等）。
 * @param {string} groupId 群 ID
 * @param {number} left 视口 left（px）
 * @param {number} top 视口 top（px）
 * @returns {Promise<void>}
 */
async function mountGroupActionMenuAt(groupId, left, top) {
	dismissGroupActionMenu()

	const group = hubStore.groups.find(g => g.groupId === groupId)
	const groupName = group?.name || groupId

	const menu = document.createElement('ul')
	menu.className = 'menu menu-sm bg-base-100 rounded-box shadow-lg border border-base-300 p-1 z-50'
	const menuWidth = 200
	const clampedLeft = Math.min(left, window.innerWidth - menuWidth - 8)
	const clampedTop = Math.min(top, window.innerHeight - 8)
	menu.style.cssText = `position:fixed;left:${Math.max(8, clampedLeft)}px;top:${Math.max(8, clampedTop)}px;min-width:10rem;max-width:${menuWidth}px;`
	menu.appendChild(await renderTemplate('hub/modals/group_context_menu', { groupId }))
	document.body.appendChild(menu)
	openMenuEl = menu

	/**
	 *
	 */
	const closeOnce = () => {
		dismissGroupActionMenu()
		document.removeEventListener('click', closeOnce, true)
		document.removeEventListener('contextmenu', closeOnce, true)
	}
	setTimeout(() => {
		document.addEventListener('click', closeOnce, true)
		document.addEventListener('contextmenu', closeOnce, true)
	}, 0)

	menu.querySelector('.hub-group-menu-manage')?.addEventListener('click', () => {
		dismissGroupActionMenu()
		navigateToGroupSettings(groupId)
	})

	menu.querySelector('.hub-group-menu-invite')?.addEventListener('click', async () => {
		dismissGroupActionMenu()
		try {
			const ticket = await createGroupInvite(groupId)
			const url = ticket.clipboardText
				|| buildInviteJoinShareUrl(
					groupId,
					ticket.code,
					ticket.mqttRoomSecret,
					ticket.introducerPubKeyHash,
				)
			await navigator.clipboard.writeText(url)
			showToastI18n('success', 'chat.hub.groupContext.inviteCopied')
		}
		catch (err) {
			showToastI18n('error', 'chat.hub.shareGroupFailed', { error: err.message })
		}
	})

	menu.querySelector('.hub-group-menu-add-char')?.addEventListener('click', async () => {
		dismissGroupActionMenu()
		await showAddCharDialog(groupId)
	})

	menu.querySelector('.hub-group-menu-leave')?.addEventListener('click', async () => {
		dismissGroupActionMenu()
		if (!confirmI18n('chat.hub.groupContext.leaveConfirm', { name: groupName }))
			return
		try {
			await leaveGroup(groupId)
			closeGroupWebSocket()
			hubStore.groups = hubStore.groups.filter(g => g.groupId !== groupId)
			if (hubStore.currentGroupId === groupId) {
				if (hubStore.privateGroup.groupId === groupId) clearPrivateGroupState()
				const next = hubStore.groups[0]?.groupId
				if (next) await selectGroup(next)
				else {
					hubStore.currentGroupId = null
					hubStore.currentChannelId = null
					hubStore.currentState = null
				}
			}
			void renderServerBar()
			showToastI18n('success', 'chat.hub.groupContext.leaveOk')
		}
		catch (err) {
			showToastI18n('error', 'chat.hub.operationFailed', { error: err.message })
		}
	})
}

/**
 * 在鼠标位置显示群右键菜单。
 * @param {MouseEvent} event 右键事件
 * @param {string} groupId 群 ID
 * @returns {Promise<void>}
 */
export async function showGroupContextMenu(event, groupId) {
	event.preventDefault()
	event.stopPropagation()
	await mountGroupActionMenuAt(groupId, event.clientX, event.clientY)
}

/**
 * 在群名标题下方显示群操作下拉菜单。
 * @param {HTMLElement} anchorEl `#hub-group-header`
 * @returns {Promise<void>}
 */
export async function showGroupHeaderMenu(anchorEl) {
	const groupId = hubStore.currentGroupId
	if (!groupId || !(anchorEl instanceof HTMLElement)) return
	const rect = anchorEl.getBoundingClientRect()
	await mountGroupActionMenuAt(groupId, rect.left, rect.bottom + 4)
}

/**
 * 弹出角色选择并加入群。
 * @param {string} groupId 群 ID
 * @returns {Promise<void>}
 */
async function showAddCharDialog(groupId) {
	let chars = []
	try {
		chars = await getPartList('chars')
	}
	catch {
		chars = []
	}
	if (!chars.length) {
		showToastI18n('warning', 'chat.hub.groupContext.noChars')
		return
	}
	const modal = document.createElement('dialog')
	modal.className = 'modal'
	modal.appendChild(await renderTemplate('hub/modals/add_char', {}))
	const select = modal.querySelector('#hub-add-char-select')
	if (select instanceof HTMLSelectElement)
		select.innerHTML = await renderTemplateAsHtmlString('hub/modals/char_select_options', { chars, escapeHtml })
	/**
	 *
	 */
	const closeModal = () => {
		modal.close()
		modal.remove()
	}
	modal.querySelector('.hub-add-char-cancel')?.addEventListener('click', closeModal)
	modal.querySelector('.hub-add-char-submit')?.addEventListener('click', async () => {
		const select = modal.querySelector('#hub-add-char-select')
		const charname = select instanceof HTMLSelectElement ? select.value.trim() : ''
		if (!charname) return
		try {
			await groupRequest(groupId, 'char', 'POST', { charname })
			showToastI18n('success', 'chat.dragAndDrop.charAdded', { partName: charname })
			closeModal()
		}
		catch (err) {
			showToastI18n('error', 'chat.hub.operationFailed', { error: err.message })
		}
	})
	document.body.appendChild(modal)
	modal.showModal()
}
