/**
 * 【文件】public/hub/chatGestures.mjs
 * 【职责】移动端/触控聊天手势：末条角色消息左右滑动切换时间轴分支，桌面端显示箭头按钮。
 * 【原理】`createChatGestures` 在消息列表上注册 pointer/touch 监听器并显示滑动提示反馈。手势触发后调用 `reloadMessages` 或 composer 预填，不直接渲染 HTML。
 * 【数据结构】hubStore 及模块内 Map/Set 字段；见 core/state 与各函数 JSDoc。
 * 【关联】../../../../scripts/template、../src/api/groupApi、core/state
 */
import { renderTemplate } from '../../../../scripts/template.mjs'
import { modifyChannelTimeline } from '../src/api/groupApi.mjs'

import { hubStore } from './core/state.mjs'

/** @type {WeakMap<HTMLElement, object>} */
const chatSwipeListenersMap = new WeakMap()
const CHAT_SWIPE_THRESHOLD = 50

/** @type {ReturnType<typeof createChatGestures> | null} */
let chatGestures = null

/**
 * 创建私聊手势：时间轴箭头、末条角色消息滑动切换。
 * @param {object} opts 依赖注入
 * @param {() => string|null} opts.getGroupId 当前群 ID
 * @param {() => string|null} opts.getChannelId 当前频道 ID
 * @param {() => Promise<void>} opts.reloadMessages 刷新频道消息
 * @returns {{ updateHideCharNames: (entries: Array<object>) => void, attachLastCharMessageSwipe: (container: HTMLElement) => void }} 手势 API
 */
export function createChatGestures({ getGroupId, getChannelId, reloadMessages }) {
	/**
	 * 角色较少时隐藏消息中的角色名。
	 * @param {Array<object>} entries 频道消息或日志条目
	 * @returns {void}
	 */
	function updateHideCharNames(entries) {
		const uniqueChars = new Set(
			(entries || [])
				.map(entry => entry.charId || (entry.role === 'char' ? entry.name : null))
				.filter(Boolean),
		)
		document.getElementById('hub-messages')
			?.classList.toggle('hide-char-names', uniqueChars.size <= 2)
	}

	/**
	 * 在末条角色消息两侧挂载桌面时间轴箭头按钮。
	 * @param {HTMLElement} lastChar 末条角色消息 DOM
	 * @returns {void}
	 */
	async function attachDesktopTimelineArrows(lastChar) {
		lastChar.querySelectorAll('.hub-char-timeline-arrow').forEach(arrow => arrow.remove())
		const groupId = getGroupId()
		const channelId = getChannelId()
		if (!groupId || !channelId) return

		/**
		 * 按偏移修改频道时间轴并刷新消息。
		 * @param {number} delta 时间轴步进（-1 或 1）
		 * @returns {Promise<void>}
		 */
		const goTimeline = async delta => {
			try {
				await modifyChannelTimeline(groupId, channelId, delta)
				await reloadMessages()
			}
			catch (err) {
				console.error('timeline arrow', err)
			}
		}

		const left = await renderTemplate('hub/chat/timeline_arrow', { side: 'left', arrow: '❮' })
		left.addEventListener('click', e => {
			e.stopPropagation()
			void goTimeline(-1)
		})
		const right = await renderTemplate('hub/chat/timeline_arrow', { side: 'right', arrow: '❯' })
		right.addEventListener('click', e => {
			e.stopPropagation()
			void goTimeline(1)
		})
		lastChar.appendChild(left)
		lastChar.appendChild(right)
	}

	/**
	 * 为末条角色消息绑定触摸滑动以切换时间轴。
	 * @param {HTMLElement} container 消息列表根节点
	 * @returns {void}
	 */
	function attachLastCharMessageSwipe(container) {
		if (!(container instanceof HTMLElement)) return
		for (const el of container.querySelectorAll('.hub-message[data-char-id], .hub-chat-entry[data-role="char"], .hub-char-entry[data-role="char"]')) {
			const prev = chatSwipeListenersMap.get(el)
			if (prev) {
				el.removeEventListener('touchstart', prev.touchstart)
				el.removeEventListener('touchmove', prev.touchmove)
				el.removeEventListener('touchend', prev.touchend)
				el.removeEventListener('touchcancel', prev.touchcancel)
				chatSwipeListenersMap.delete(el)
			}
		}
		const charEls = container.querySelectorAll('.hub-message[data-char-id], .hub-chat-entry[data-role="char"], .hub-char-entry[data-role="char"]')
		const lastChar = charEls.length ? charEls[charEls.length - 1] : null
		if (!(lastChar instanceof HTMLElement) || lastChar.hasAttribute('data-streaming')) return

		void attachDesktopTimelineArrows(lastChar)

		let touchStartX = 0
		let touchStartY = 0
		let isDragging = false
		let swipeHandled = false

		/** @param {TouchEvent} event 触摸开始 */
		const handleTouchStart = event => {
			if (event.touches.length !== 1) return
			touchStartX = event.touches[0].clientX
			touchStartY = event.touches[0].clientY
			isDragging = true
			swipeHandled = false
		}
		/** @param {TouchEvent} event 触摸移动 */
		const handleTouchMove = event => {
			if (!isDragging || event.touches.length !== 1) return
			const deltaX = event.touches[0].clientX - touchStartX
			const deltaY = event.touches[0].clientY - touchStartY
			if (Math.abs(deltaY) > Math.abs(deltaX)) isDragging = false
		}
		/** @param {TouchEvent} event 触摸结束 */
		const handleTouchEnd = async event => {
			if (!isDragging || swipeHandled || event.changedTouches.length !== 1) {
				isDragging = false
				return
			}
			const deltaX = event.changedTouches[0].clientX - touchStartX
			const deltaY = event.changedTouches[0].clientY - touchStartY
			isDragging = false
			const groupId = getGroupId()
			const channelId = getChannelId()
			if (Math.abs(deltaX) > CHAT_SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY) && groupId && channelId) {
				swipeHandled = true
				try {
					await modifyChannelTimeline(groupId, channelId, deltaX > 0 ? -1 : 1)
					await reloadMessages()
				}
				catch (err) {
					console.error('swipe timeline', err)
				}
			}
		}
		/** @returns {void} */
		const handleTouchCancel = () => { isDragging = false }

		const listeners = { touchstart: handleTouchStart, touchmove: handleTouchMove, touchend: handleTouchEnd, touchcancel: handleTouchCancel }
		chatSwipeListenersMap.set(lastChar, listeners)
		lastChar.addEventListener('touchstart', handleTouchStart, { passive: true })
		lastChar.addEventListener('touchmove', handleTouchMove, { passive: true })
		lastChar.addEventListener('touchend', handleTouchEnd, { passive: true })
		lastChar.addEventListener('touchcancel', handleTouchCancel, { passive: true })
	}

	return { updateHideCharNames, attachLastCharMessageSwipe }
}

/** @returns {ReturnType<typeof createChatGestures>} 二人角色对话手势实例 */
export function getChatGestures() {
	if (!chatGestures) 
		chatGestures = createChatGestures({
			/** @returns {string|null} 当前群 ID */
			getGroupId: () => hubStore.currentGroupId || hubStore.privateGroup.groupId,
			/** @returns {string|null} 当前频道 ID */
			getChannelId: () => hubStore.currentChannelId || hubStore.privateGroup.channelId,
			/** @returns {Promise<void>} 刷新频道消息 */
			reloadMessages: async () => {
				const { loadMessages } = await import('./messages/messages.mjs')
				await loadMessages()
			},
		})
	
	return chatGestures
}

/** 重置手势单例（Hub 初始化时调用）。 @returns {void} */
export function resetChatGestures() {
	chatGestures = null
}
