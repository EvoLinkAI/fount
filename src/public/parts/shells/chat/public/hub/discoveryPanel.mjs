/**
 * Hub 群发现侧栏/模态。
 */
import { i18nElement } from '../../../../scripts/i18n.mjs'
import { showToastI18n } from '../../../../scripts/toast.mjs'
import { fetchDiscoveryIndex, refreshDiscoveryGossip } from '../src/api/discoveryApi.mjs'

import { escapeHtml } from './core/domUtils.mjs'
import { selectGroup } from './groupNav.mjs'

/**
 * 打开群发现列表模态。
 * @returns {Promise<void>}
 */
export async function openDiscoveryPanel() {
	void refreshDiscoveryGossip().catch(() => {})
	let entries = []
	try {
		const data = await fetchDiscoveryIndex({ limit: 80 })
		entries = data.entries || []
	}
	catch (error) {
		showToastI18n('error', 'chat.hub.discoveryLoadFailed', { message: error.message })
		return
	}

	const modal = document.createElement('dialog')
	modal.className = 'modal modal-open'
	const rows = entries.length
		? entries.map(entry => {
			const sources = (entry.sources || [])
				.map(source => escapeHtml(source.fromNodeHash?.slice(0, 12) || '?'))
				.join(', ')
			return `\
<li class="border-b border-base-300 py-2 cursor-pointer hover:bg-base-200 rounded px-2 hub-discovery-row" data-group-id="${escapeHtml(entry.groupId)}" role="button" tabindex="0">
	<div class="font-medium">${escapeHtml(entry.title || entry.groupId)}</div>
	<div class="text-sm opacity-70">${escapeHtml(entry.blurb || '')}</div>
	<div class="text-xs opacity-50">${escapeHtml(entry.groupId)} · ${sources}</div>
</li>
`
		}).join('')
		: '<li class="py-4 text-center opacity-60" data-i18n="chat.hub.discoveryEmpty"></li>'

	modal.innerHTML = `\
<div class="modal-box max-w-lg">
	<h3 class="font-bold text-lg" data-i18n="chat.hub.discoveryTitle"></h3>
	<ul class="mt-4 max-h-96 overflow-y-auto">${rows}</ul>
	<div class="modal-action">
		<button type="button" class="btn btn-ghost" data-discovery-refresh data-i18n="chat.hub.discoveryRefresh"></button>
		<button type="button" class="btn" data-discovery-close data-i18n="common.close"></button>
	</div>
</div>
<form method="dialog" class="modal-backdrop"><button type="submit">close</button></form>
`
	document.body.appendChild(modal)
	modal.querySelector('[data-discovery-close]')?.addEventListener('click', () => modal.close())
	modal.querySelector('[data-discovery-refresh]')?.addEventListener('click', async () => {
		modal.close()
		await openDiscoveryPanel()
	})
	modal.querySelectorAll('.hub-discovery-row[data-group-id]').forEach(row => {
		/**
		 * @returns {Promise<void>}
		 */
		const openGroup = async () => {
			const groupId = row.getAttribute('data-group-id')
			if (!groupId) return
			modal.close()
			await selectGroup(groupId)
		}
		row.addEventListener('click', () => { void openGroup() })
		row.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault()
				void openGroup()
			}
		})
	})
	modal.addEventListener('close', () => modal.remove())
	i18nElement(modal)
}
