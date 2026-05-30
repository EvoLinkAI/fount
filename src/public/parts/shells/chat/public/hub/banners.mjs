/**
 * 【文件】public/hub/banners.mjs
 * 【职责】Hub 顶栏与主区横幅：置顶/书签侧栏显隐、明文模式提示、DAG 分叉横幅与频道置顶条刷新。
 * 【原理】操作 `#hub-pins-bookmarks-wrap`、`#hub-plaintext-main-banner`、`#hub-dag-fork-banner` 等固定占位元素。`refreshChannelPinsBar` 根据置顶事件更新顶栏摘要，与 `pinPreview` 协作展示引用预览。
 * 【数据结构】hubStore 及模块内 Map/Set 字段；见 core/state 与各函数 JSDoc。
 * 【关联】../../../../scripts/template、../src/lib/pubKeyHex、core/domUtils、core/state
 */
import { renderTemplateAsHtmlString } from '../../../../scripts/template.mjs'
import { isHex64 } from '../src/lib/pubKeyHex.mjs'

import { escapeHtml } from './core/domUtils.mjs'
import { hubStore } from './core/state.mjs'
import { getMailboxPendingCount, refreshMailboxPendingCount } from './hubNotifications.mjs'

/**
 * 显示或隐藏置顶/书签侧栏容器。
 * @param {boolean} on 是否显示
 * @returns {void} 无
 */
export function setPinsBookmarksWrapVisible(on) {
	const wrap = document.getElementById('hub-pins-bookmarks-wrap')
	if (!wrap) return
	if (on) wrap.removeAttribute('hidden')
	else wrap.setAttribute('hidden', '')
}

/** @returns {void} */
export function updatePlaintextMainBanner() {
	const el = document.getElementById('hub-plaintext-main-banner')
	const textEl = document.getElementById('hub-plaintext-main-banner-text')
	if (!el || !textEl) return
	const channel = hubStore.currentState?.channels?.[hubStore.currentChannelId]
	const show = hubStore.currentMode === 'groups'
		&& hubStore.currentGroupId
		&& hubStore.currentState?.isMember
		&& channel?.syncScope === 'channel'
	if (show) {
		textEl.dataset.i18n = 'chat.hub.banners.plaintextSidecar'
		el.removeAttribute('hidden')
		return
	}
	el.setAttribute('hidden', '')
}

/** @returns {void} */
export function refreshQuarantineBanner() {
	const el = document.getElementById('hub-quarantine-banner')
	const textEl = document.getElementById('hub-quarantine-banner-text')
	if (!el || !textEl) return
	const count = Number(hubStore.currentState?.quarantineCount) || 0
	const show = hubStore.currentMode === 'groups'
		&& hubStore.currentGroupId
		&& hubStore.currentState?.isMember
		&& count > 0
	if (show) {
		textEl.dataset.count = String(count)
		textEl.dataset.i18n = 'chat.hub.banners.quarantine'
		el.removeAttribute('hidden')
		return
	}
	el.setAttribute('hidden', '')
}

/** @returns {Promise<void>} */
export async function refreshMailboxBanner() {
	const el = document.getElementById('hub-mailbox-banner')
	const textEl = document.getElementById('hub-mailbox-banner-text')
	if (!el || !textEl) return
	await refreshMailboxPendingCount()
	const pending = getMailboxPendingCount()
	if (pending > 0) {
		textEl.dataset.count = String(pending)
		textEl.dataset.i18n = 'chat.hub.banners.mailboxPending'
		el.removeAttribute('hidden')
		return
	}
	el.setAttribute('hidden', '')
}

/** @returns {Promise<void>} */
export async function refreshDagForkBanner() {
	const banner = document.getElementById('hub-fork-banner')
	const textEl = document.getElementById('hub-fork-banner-text')
	const mergeButton = document.getElementById('hub-fork-merge-button')
	const tipSelect = document.getElementById('hub-fork-tip-select')
	if (!banner || !textEl) return
	if (hubStore.currentMode !== 'groups' || !hubStore.currentGroupId || !hubStore.currentState?.isMember) {
		banner.setAttribute('hidden', '')
		hubStore.dagTips = []
		return
	}
	const response = await fetch(
		`/api/parts/shells:chat/groups/${encodeURIComponent(hubStore.currentGroupId)}/dag/tips`,
		{ credentials: 'include' },
	)
	const data = await response.json()
	const tips = Array.isArray(data.tips) ? data.tips : []
	hubStore.dagTips = tips
	const governanceFork = !!data.governanceFork || !!hubStore.currentState?.governanceFork
	if (tips.length < 2 && !governanceFork) {
		banner.setAttribute('hidden', '')
		return
	}
	banner.removeAttribute('hidden')
	textEl.dataset.i18n = governanceFork && tips.length < 2
		? 'chat.hub.banners.forkGovernance'
		: 'chat.hub.banners.forkTips'
	textEl.dataset.count = String(tips.length)
	if (mergeButton) mergeButton.disabled = tips.length < 2
	refreshLocalViewBanner()
	if (tipSelect) {
		const preferred = data.consensusBranchTip || data.authzBranchTip || hubStore.currentState?.consensusBranchTip || ''
		const tipScores = data.tipConsensusScores || data.tipScores || {}
		if (!tips.length) 
			tipSelect.innerHTML = ''
		
		else {
			const tipRows = tips.map(id => {
				const short = id.length > 12 ? `${id.slice(0, 10)}…` : id
				const score = Number(tipScores[id])
				return {
					id: escapeHtml(id),
					short: escapeHtml(short),
					score: Number.isFinite(score) ? String(Math.floor(score)) : '',
					i18nKey: Number.isFinite(score) ? 'chat.hub.banners.forkTipScore' : '',
					selected: id === preferred,
				}
			})
			tipSelect.innerHTML = await renderTemplateAsHtmlString('hub/banners/fork_tip_options', { tips: tipRows })
		}
		const current = tipSelect.value
		if (current && [...tipSelect.options].some(opt => opt.value === current)) tipSelect.value = current
	}
}

/**
 * 联邦同步进度横幅。
 * @param {boolean} on 是否显示
 * @param {{ i18nKey?: string, params?: Record<string, string | number> }} [opts] `data-i18n` 键与 dataset 插值
 * @returns {void}
 */
export function setSyncBanner(on, opts) {
	const el = document.getElementById('hub-sync-banner')
	const textEl = document.getElementById('hub-sync-banner-text')
	if (!el) return
	if (on) {
		el.removeAttribute('hidden')
		if (textEl) {
			const key = opts?.i18nKey || 'chat.hub.banners.syncing'
			textEl.dataset.i18n = key
			for (const k of Object.keys(textEl.dataset))
				if (k !== 'i18n') delete textEl.dataset[k]
			for (const [k, v] of Object.entries(opts?.params || {}))
				textEl.dataset[k] = String(v)
		}
	}
	else el.setAttribute('hidden', '')
}

/**
 * 分叉 tip 下拉框当前选中值，无选中时回退到首个 tip。
 * @returns {string | undefined} 选中的 DAG tip id
 */
export function selectedForkTipId() {
	const value = document.getElementById('hub-fork-tip-select')?.value?.trim().toLowerCase()
	if (isHex64(value)) return value
	return hubStore.dagTips[0]
}

/** @returns {Promise<void>} */
export async function refreshChannelPinsBar() {
	const bar = document.getElementById('hub-channel-pins-bar')
	if (!bar) return
	if (hubStore.currentMode !== 'groups' || !hubStore.currentGroupId || !hubStore.currentChannelId) {
		bar.setAttribute('hidden', '')
		bar.innerHTML = ''
		return
	}
	const ids = hubStore.currentState?.pinsByChannel?.[hubStore.currentChannelId]
	if (!Array.isArray(ids) || !ids.length) {
		bar.setAttribute('hidden', '')
		bar.innerHTML = ''
		return
	}
	bar.removeAttribute('hidden')
	const pins = ids.map(eventId => {
		const short = eventId.length > 10 ? `${eventId.slice(0, 8)}…` : eventId
		return { eventId: escapeHtml(eventId), short: escapeHtml(short) }
	})
	bar.innerHTML = await renderTemplateAsHtmlString('hub/banners/pins_chips', { pins })
	bar.querySelectorAll('.hub-pinned-message-chip').forEach(pinChip => {
		pinChip.addEventListener('click', () => {
			document.querySelector(`#hub-messages [data-message-id="${pinChip.getAttribute('data-pinned-message-event')}"]`)
				?.scrollIntoView({ block: 'center', behavior: 'smooth' })
		})
	})
}

/** @returns {void} */
export function refreshGshBufferBanner() {
	const el = document.getElementById('hub-group-state-host-buffer-banner')
	const textEl = document.getElementById('hub-group-state-host-buffer-banner-text')
	if (!el || !textEl) return
	const total = Number(hubStore.currentState?.gshBuffer?.total) || 0
	if (hubStore.currentMode === 'groups' && hubStore.currentGroupId && hubStore.currentState?.isMember && total > 0) {
		textEl.dataset.total = String(total)
		textEl.dataset.i18n = 'chat.hub.banners.gshBuffer'
		el.removeAttribute('hidden')
		return
	}
	el.setAttribute('hidden', '')
}

/** @returns {void} */
export function refreshLocalViewBanner() {
	const el = document.getElementById('hub-local-view-banner')
	if (!el) return
	const consensus = hubStore.currentState?.consensusBranchTip || hubStore.currentState?.authzBranchTip || ''
	const localView = hubStore.currentState?.localViewBranchTip || ''
	const hasDiff = !!localView && !!consensus && localView !== consensus
	const show = hubStore.currentMode === 'groups' && hubStore.currentGroupId && hubStore.currentState?.isMember
		&& hasDiff
	if (show) el.removeAttribute('hidden')
	else el.setAttribute('hidden', '')
}

/** @returns {void} */
export function updateStatusBanners() {
	updatePlaintextMainBanner()
	refreshGshBufferBanner()
	refreshQuarantineBanner()
	refreshLocalViewBanner()
	void refreshChannelPinsBar()
	void refreshMailboxBanner()
	void refreshDagForkBanner().then(() => refreshLocalViewBanner())
}
