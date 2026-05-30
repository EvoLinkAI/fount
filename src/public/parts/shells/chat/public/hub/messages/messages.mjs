/**
 * 【文件】public/hub/messages/messages.mjs
 * 【职责】频道消息主控：虚拟列表管道、发送/编辑、增量刷新、输入区启停与 Hub 顶栏按钮联动。
 * 【原理】`loadMessages`/`sendCurrentMessage` 驱动 `MessagePipeline` 虚拟列表与 composer 显隐。
 *   协调 `messageRender`、反应条与搜索过滤；消费 `groupStream` 增量刷新与流式槽同步。
 * 【数据结构】hubStore（core/state）及本模块函数入参/返回值；详见 JSDoc。
 * 【关联】../../../../../scripts/template、../../../../../scripts/toast、../../src/api/groupApi、../../src/groupViewerPermissions、../../src/lib/emojiSvg、../../src/MessagePipeline、../../src/ui/channelDisplay。
 */
import {
	createDocumentFragmentFromHtmlStringNoScriptActivation,
	mountTemplate,
} from '../../../../../scripts/template.mjs'
import { showToastI18n } from '../../../../../scripts/toast.mjs'
import {
	getChannelMessages,
	getStreamingChannelAuth,
	requestChannelHistoryFromPeers,
	sendGroupMessage,
} from '../../src/api/groupApi.mjs'
import { viewerCanAddReactions, viewerCanManageMessages, viewerCanPinMessages } from '../../src/groupViewerPermissions.mjs'
import { hubEmptyWaveIcon } from '../../src/lib/emojiSvg.mjs'
import { createMessagePipeline } from '../../src/MessagePipeline.mjs'
import { applyChannelDisplayChain } from '../../src/ui/channelDisplay.mjs'
import { refreshChannelPinsBar } from '../banners.mjs'
import { renderListChannel, renderStreamingChannel, renderWebRtcStreamingChannel } from '../channels.mjs'
import { getChatGestures } from '../chatGestures.mjs'
import { clearSelectedFiles, selectedFiles, stopVoiceIfRecording } from '../composerFiles.mjs'
import { activeCharPartNames } from '../core/domUtils.mjs'
import { hubStore } from '../core/state.mjs'
import { selectChannel, saveListChannelItems } from '../groupNav.mjs'
import {
	catchUpVolatileStreamFromServer,
	dismissVolatileStreamPreview,
	getActiveVolatileStreamIds,
	syncStreamingSlotsFromDom,
	waitForGroupWebSocketOpen,
} from '../groupStream.mjs'
import { applyAvatarsTo } from '../presence.mjs'
import { leaveHubAvSession } from '../streamingAv.mjs'
import { isThreadDrawerOpen } from '../threadDrawer.mjs'

import { bindChannelMessageActions } from './messageActionsHandlers.mjs'
import { setChannelMessageActionsContext } from './messageActionsState.mjs'
import {
	getMessageText,
	isChannelMessageGenerating,
	localizeRenderedMessages,
	renderChannelMessageBlock,
	renderMessageReactionsHtml,
} from './messageRender.mjs'
import { wireMessageReactions } from './reactions.mjs'

/** @type {ReturnType<typeof setTimeout> | null} */
let channelIncrementalDebounceTimer = null

/** @type {string | null} 虚拟列表重建后滚动定位的消息 event id */
let pendingScrollToEventId = null

/**
 * 按顶栏搜索关键词过滤展示行。
 * @param {object[]} messages 物化后的消息行
 * @returns {object[]} 过滤后的消息行
 */
function applyChannelSearchFilter(messages) {
	const q = hubStore.channelSearchQuery
	if (!q) return messages
	return messages.filter(message => getMessageText(message).toLowerCase().includes(q))
}

/** 从 API 物化行重建展示列表（分叉链 + 搜索）。 @returns {void} */
function refreshChannelView() {
	hubStore.channelMessages = applyChannelSearchFilter(
		applyChannelDisplayChain(hubStore.channelMessagesSource),
	)
}

/** @returns {void} */
function updateLastMessageId() {
	const last = hubStore.channelMessagesSource.at(-1)
	hubStore.lastMessageId = last?.eventId || null
}

/** 销毁当前频道虚拟列表。 @returns {void} */
function destroyChannelVirtualList() {
	hubStore.channelMessagePipeline?.destroy()
	hubStore.channelMessagePipeline = null
}

/**
 * @param {HTMLElement} container 消息列表容器
 * @param {boolean} [shouldScroll=false] 是否滚到底部
 * @returns {void}
 */
function decorateRenderedMessages(container, shouldScroll = false) {
	localizeRenderedMessages(container)
	syncStreamingSlotsFromDom(container)
	applyAvatarsTo(container)
	bindReactions(container)
	bindChannelMessageActions(container)
	if (isTwoPartyCharDialogue()) {
		const gestures = getChatGestures()
		gestures.updateHideCharNames(hubStore.channelMessages)
		gestures.attachLastCharMessageSwipe(container)
	}
	if (shouldScroll) scrollToBottom()
}

/**
 * @param {HTMLElement} container 消息列表根节点
 * @param {object[]} reactionEvents 本轮 reaction DAG 行
 * @returns {Promise<void>}
 */
async function patchReactionRows(container, reactionEvents) {
	hubStore.channelReactionEvents = reactionEvents
	const opts = messageRenderOpts()
	for (const message of hubStore.channelMessages) {
		if (message.type !== 'message' || !message.eventId) continue
		const eventId = String(message.eventId)
		const row = container.querySelector(messageIdSelector(eventId))
		if (!row) continue
		const html = await renderMessageReactionsHtml(
			message,
			hubStore.channelMessages,
			reactionEvents,
			opts.viewerMemberId,
			{ canAddReactions: opts.canAddReactions },
		)
		const existing = row.querySelector('.hub-reactions')
		if (!html) {
			existing?.remove()
			continue
		}
		const frag = await createDocumentFragmentFromHtmlStringNoScriptActivation(html)
		const next = frag.firstElementChild
		if (existing) existing.replaceWith(next)
		else row.appendChild(next)
	}
	bindReactions(container)
}

/**
 * @param {object} message 消息行
 * @param {number} index 全局索引
 * @returns {Promise<HTMLElement>} 渲染后的消息节点
 */
async function renderChannelMessageElement(message, index) {
	const prev = index > 0 ? hubStore.channelMessages[index - 1] : null
	const lastId = hubStore.channelMessages.at(-1)?.eventId
	const block = await renderChannelMessageBlock(
		message,
		prev?.charId || prev?.sender || null,
		prev?.timestamp || 0,
		hubStore.channelMessages,
		{ ...messageRenderOpts(), lastMessageEventId: lastId },
	)
	const frag = await createDocumentFragmentFromHtmlStringNoScriptActivation(block.html)
	return frag.firstElementChild
}

/**
 * @returns {Promise<number>} 新增加的展示条数
 */
async function loadOlderMessages() {
	if (hubStore.channelOlderExhausted.value || !hubStore.currentGroupId || !hubStore.currentChannelId) return 0
	const oldest = hubStore.channelMessages[0]
	const oldestId = oldest?.eventId
	if (!oldestId || String(oldestId).startsWith('pending:')) {
		hubStore.channelOlderExhausted.value = true
		return 0
	}
	const limit = Math.max(1, Math.ceil(hubStore.channelMessages.length / 2))
	let batch = []
	try {
		const { messages } = await getChannelMessages(hubStore.currentGroupId, hubStore.currentChannelId, {
			before: oldestId,
			limit,
		})
		batch = messages || []
	}
	catch {
		batch = []
	}
	if (!batch.length)
		try {
			batch = await requestChannelHistoryFromPeers(hubStore.currentGroupId, hubStore.currentChannelId, {
				before: oldestId,
				limit,
			})
		}
		catch {
			batch = []
		}

	if (!batch.length) {
		hubStore.channelOlderExhausted.value = true
		return 0
	}
	const known = new Set(
		hubStore.channelMessagesSource.map(m => String(m.eventId)).filter(Boolean),
	)
	const fresh = batch.filter(m => {
		const eventId = String(m.eventId)
		return eventId && !known.has(eventId)
	})
	if (!fresh.length) {
		hubStore.channelOlderExhausted.value = true
		return 0
	}
	hubStore.channelMessagesSource = [...fresh, ...hubStore.channelMessagesSource]
	refreshChannelView()
	syncChannelActionsContext()
	return fresh.length
}

/**
 * @param {HTMLElement} container 消息容器
 * @returns {void}
 */
function initChannelVirtualList(container) {
	destroyChannelVirtualList()
	hubStore.channelMessagePipeline = createMessagePipeline({
		container,
		loadMoreTop: loadOlderMessages,
		/**
		 * @param {number} offset 起始索引
		 * @param {number} limit 条数
		 * @returns {Promise<{ items: object[], total: number }>} 分页数据
		 */
		fetchData: async (offset, limit) => {
			if (limit === 0) return { items: [], total: hubStore.channelMessages.length }
			return {
				items: hubStore.channelMessages.slice(offset, offset + limit),
				total: hubStore.channelMessages.length,
			}
		},
		/**
		 * @param {object} item 消息行
		 * @param {number} index 索引
		 * @returns {Promise<HTMLElement>} 消息行元素
		 */
		renderItem: (item, index) => renderChannelMessageElement(item, index),
		initialIndex: (() => {
			if (!pendingScrollToEventId) return Math.max(0, hubStore.channelMessages.length - 1)
			const norm = String(pendingScrollToEventId).trim().toLowerCase()
			const idx = hubStore.channelMessages.findIndex(
				m => String(m.eventId || '').trim().toLowerCase() === norm,
			)
			pendingScrollToEventId = null
			return idx >= 0 ? idx : Math.max(0, hubStore.channelMessages.length - 1)
		})(),
		/** @returns {void} */
		onRenderComplete: () => decorateRenderedMessages(container),
	})
}

/** @returns {Promise<void>} */
export async function refreshReactionPerms() {
	if (!hubStore.currentState || !hubStore.currentGroupId || !hubStore.currentChannelId) {
		hubStore.reactionRenderOpts = { viewerMemberId: 'local', canAddReactions: false, canManageMessages: false, canPinMessages: false }
		return
	}
	const viewerMemberId = hubStore.currentState.viewerMemberPubKeyHash || 'local'
	const [canAddReactions, canManageMessages, canPinMessages] = await Promise.all([
		viewerCanAddReactions(hubStore.currentState, hubStore.currentGroupId, hubStore.currentChannelId),
		viewerCanManageMessages(hubStore.currentState, hubStore.currentGroupId, hubStore.currentChannelId),
		viewerCanPinMessages(hubStore.currentState, hubStore.currentGroupId, hubStore.currentChannelId),
	])
	hubStore.reactionRenderOpts = { viewerMemberId, canAddReactions, canManageMessages, canPinMessages }
}

/** @returns {boolean} 是否双人角色对话 */
function isTwoPartyCharDialogue() {
	if (hubStore.privateGroup.charName) return true
	const state = hubStore.currentState
	if (!state) return false
	const charCount = state.charPartNames?.length ?? 0
	const activeMembers = Object.values(state.members || {}).filter(member => member?.status === 'active').length
	return charCount === 1 && activeMembers <= 2
}

/** @returns {object} 消息渲染选项 */
export function messageRenderOpts() {
	const pinnedEventIds = hubStore.currentChannelId && hubStore.currentState?.pinsByChannel?.[hubStore.currentChannelId]
		? [...hubStore.currentState.pinsByChannel[hubStore.currentChannelId]]
		: []
	return {
		reactionEvents: hubStore.channelReactionEvents,
		viewerMemberId: hubStore.reactionRenderOpts.viewerMemberId,
		canAddReactions: hubStore.reactionRenderOpts.canAddReactions,
		viewerPubKeyHash: hubStore.currentState?.viewerMemberPubKeyHash || null,
		localCharIds: activeCharPartNames(),
		canManageMessages: hubStore.reactionRenderOpts.canManageMessages,
		canPinMessages: hubStore.reactionRenderOpts.canPinMessages,
		pinnedEventIds,
		alwaysVisibleActions: isTwoPartyCharDialogue(),
		canCreateThreads: !!hubStore.currentState?.channelCaps?.[hubStore.currentChannelId]?.canCreateThreads,
	}
}

/** @returns {void} */
export function syncChannelActionsContext() {
	setChannelMessageActionsContext({
		groupId: hubStore.currentGroupId,
		channelId: hubStore.currentChannelId,
		messages: hubStore.channelMessages,
		reload: loadMessages,
	})
}

/** @param {HTMLElement} container @returns {void} */
export function bindReactions(container) {
	wireMessageReactions(container, {
		groupId: hubStore.currentGroupId,
		channelId: hubStore.currentChannelId,
		messages: hubStore.channelMessages,
		reactionEvents: hubStore.channelReactionEvents,
		viewerMemberId: hubStore.reactionRenderOpts.viewerMemberId,
		canManageMessages: hubStore.reactionRenderOpts.canManageMessages,
		reload: loadMessages,
	})
}

/**
 * 刷新虚表（搜索/overlay 全量变更）。
 * @param {HTMLElement} container 消息列表根节点
 * @param {boolean} [scrollBottom=false] 是否滚到底部
 * @returns {Promise<void>}
 */
export async function refreshChannelViewDom(container, scrollBottom = false) {
	refreshChannelView()
	syncChannelActionsContext()
	if (!hubStore.channelMessages.length) {
		destroyChannelVirtualList()
		await mountTemplate(container, 'hub/empty/idle', { iconHtml: hubEmptyWaveIcon })
		hubStore.lastMessageId = null
		return
	}
	if (!hubStore.channelMessagePipeline)
		initChannelVirtualList(container)
	else
		await hubStore.channelMessagePipeline.refresh()
	updateLastMessageId()
	if (scrollBottom) scrollToBottom()
}

/** @returns {Promise<void>} */
export async function loadMessages() {
	hubStore.channelSearchQuery = null
	const searchInput = document.getElementById('hub-header-search')
	if (searchInput instanceof HTMLInputElement) searchInput.value = ''
	const container = document.getElementById('hub-messages')
	const channel = hubStore.currentState?.channels?.[hubStore.currentChannelId]
	const chType = channel?.type || 'text'
	await mountTemplate(container, 'hub/empty/loading', {})
	destroyChannelVirtualList()
	if (chType === 'list') {
		await renderListChannel(container, hubStore.currentGroupId, hubStore.currentChannelId, channel, selectChannel, {
			canEdit: !!hubStore.currentState?.channelCaps?.[hubStore.currentChannelId]?.canEditList,
			onSave: saveListChannelItems,
		})
		hubStore.lastMessageId = null
		refreshChannelPinsBar()
		return
	}
	if (chType === 'streaming') {
		await leaveHubAvSession()
		const groupSettings = hubStore.currentState?.groupSettings || {}
		const useSfu = !!groupSettings.streamingSfuWss?.trim()
		if (!useSfu) {
			const clientId = hubStore.currentState?.viewerMemberPubKeyHash || 'local'
			await renderWebRtcStreamingChannel(container, channel, {
				groupId: hubStore.currentGroupId,
				channelId: hubStore.currentChannelId,
				clientId,
			})
			hubStore.lastMessageId = null
			refreshChannelPinsBar()
			return
		}
		const groupId = hubStore.currentGroupId
		const channelId = hubStore.currentChannelId
		const streamingViewPageUrl =
			`/api/parts/shells:chat/groups/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/streaming-view`
		await renderStreamingChannel(container, channel, {
			streamingSfuWss: groupSettings.streamingSfuWss,
			embedUrl: streamingViewPageUrl,
			/**
			 *
			 */
			onRefreshAuth: async () => {
				const iframe = document.getElementById('hub-stream-iframe')
				if (!(iframe instanceof HTMLIFrameElement)) return
				try {
					const auth = await getStreamingChannelAuth(groupId, channelId)
					if (auth?.embedUrl) iframe.src = auth.embedUrl
					else iframe.src = `${streamingViewPageUrl}?reload=${Date.now()}`
				}
				catch {
					iframe.src = `${streamingViewPageUrl}?reload=${Date.now()}`
				}
			},
		})
		hubStore.lastMessageId = null
		refreshChannelPinsBar()
		return
	}
	try {
		hubStore.composerPendingId = null
		hubStore.channelOlderExhausted.value = false
		const { messages, reactionEvents } = await getChannelMessages(
			hubStore.currentGroupId,
			hubStore.currentChannelId,
			{ limit: 50 },
		)
		hubStore.channelReactionEvents = reactionEvents
		hubStore.reactionEventsEtag = reactionEvents.map(e => e.eventId).sort().join(',')
		hubStore.channelMessagesSource = messages
		refreshChannelView()
		await refreshReactionPerms()
		syncChannelActionsContext()
		if (!messages.length) {
			await mountTemplate(container, 'hub/empty/idle', { iconHtml: hubEmptyWaveIcon })
			hubStore.lastMessageId = null
			return
		}
		container.innerHTML = ''
		initChannelVirtualList(container)
		updateLastMessageId()
		scrollToBottom()
		refreshChannelPinsBar()
	}
	catch (err) {
		await mountTemplate(container, 'hub/empty/error', {
			i18nKey: 'chat.hub.loadMessagesFailed',
			errorMessage: err.message,
		})
	}
}

/** @returns {void} */
export function scrollToBottom() {
	const container = document.getElementById('hub-messages')
	container.scrollTop = container.scrollHeight
}

/** @returns {void} */
export function cancelScheduledChannelRefresh() {
	if (channelIncrementalDebounceTimer) {
		clearTimeout(channelIncrementalDebounceTimer)
		channelIncrementalDebounceTimer = null
	}
}

/**
 * @param {string} eventId 消息 event id
 * @returns {boolean} 是否为乐观 pending 行
 */
function isPendingEventId(eventId) {
	return String(eventId || '').startsWith('pending:')
}

/**
 * @param {object[]} rows 消息行
 * @returns {object[]} 按时间排序
 */
function sortChannelRows(rows) {
	return [...rows].sort((a, b) => {
		const ta = Number(a.timestamp) || 0
		const tb = Number(b.timestamp) || 0
		if (ta !== tb) return ta - tb
		return String(a.eventId).localeCompare(String(b.eventId), 'und')
	})
}

/**
 * @param {object[]} source 当前 channelMessagesSource
 * @param {object[]} batch 本轮 API 返回行
 * @returns {object[]} 合并后的 source
 */
function mergeIncrementalChannelBatch(source, batch) {
	const byId = new Map()
	for (const row of source) {
		if (row.pending) continue
		const eventId = String(row.eventId)
		if (eventId) byId.set(eventId, row)
	}
	const pendingId = hubStore.composerPendingId
	if (pendingId) {
		const pending = source.find(row => String(row.eventId) === pendingId)
		if (pending) byId.set(pendingId, pending)
	}
	for (const row of batch) {
		const eventId = String(row.eventId)
		if (!eventId) continue
		byId.set(eventId, row)
		if (pendingId && eventId !== pendingId) {
			byId.delete(pendingId)
			hubStore.composerPendingId = null
		}
	}
	return sortChannelRows([...byId.values()])
}

/**
 * @param {string} messageId 消息 id
 * @returns {string} querySelector 安全选择器
 */
function messageIdSelector(messageId) {
	const eventId = String(messageId || '')
	if (!eventId) return ''
	const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(eventId) : eventId
	return `[data-message-id="${escaped}"]`
}

/**
 * 滚动到指定 DAG 消息（引用条点击等）。
 * @param {string} eventId 消息 event id
 * @returns {Promise<void>}
 */
export async function scrollToMessageEventId(eventId) {
	const norm = String(eventId || '').trim()
	if (!norm) return
	const container = document.getElementById('hub-channel-messages')
	if (!(container instanceof HTMLElement)) return
	const sel = messageIdSelector(norm)
	const existing = sel ? container.querySelector(sel) : null
	if (existing instanceof HTMLElement) {
		existing.scrollIntoView({ behavior: 'smooth', block: 'center' })
		existing.classList.add('ring-2', 'ring-primary', 'ring-offset-2')
		setTimeout(() => existing.classList.remove('ring-2', 'ring-primary', 'ring-offset-2'), 2000)
		return
	}
	pendingScrollToEventId = norm
	if (hubStore.channelMessages.length && hubStore.channelMessagePipeline) {
		destroyChannelVirtualList()
		initChannelVirtualList(container)
		decorateRenderedMessages(container, false)
		const row = sel ? container.querySelector(sel) : null
		row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
	}
}

/**
 * 将 POST 落盘的 DAG 事件转为频道消息行。
 * @param {object} event 签名后 `message` 事件
 * @returns {object} 频道消息行
 */
function channelRowFromPostedEvent(event) {
	const eventId = event?.id ?? event?.eventId
	const viewerPubKeyHash = String(hubStore.currentState?.viewerMemberPubKeyHash || '').trim().toLowerCase()
	const senderKey = String(event.sender || '').trim().toLowerCase()
	const authorPubKeyHash = /^[0-9a-f]{64}$/i.test(senderKey) ? senderKey : null
	return {
		eventId,
		type: 'message',
		content: event.content,
		sender: event.sender,
		charId: event.charId || null,
		timestamp: event.timestamp ?? event.hlc?.wall ?? Date.now(),
		authorPubKeyHash,
		isRemote: !!(authorPubKeyHash && viewerPubKeyHash && authorPubKeyHash !== viewerPubKeyHash),
	}
}

/**
 * @param {string} content 正文
 * @param {string} tempId 临时 id
 * @returns {object} 待发送占位行
 */
function pendingRowFromComposer(content, tempId) {
	const viewerPubKeyHash = hubStore.currentState?.viewerMemberPubKeyHash || null
	return {
		eventId: tempId,
		pending: true,
		type: 'message',
		content: typeof content === 'string' ? { type: 'text', content } : content,
		sender: viewerPubKeyHash,
		authorPubKeyHash: viewerPubKeyHash,
		timestamp: Date.now(),
		isRemote: false,
	}
}

/**
 * 乐观插入待发送行。
 * @param {string} content 正文
 * @param {string} tempId 临时 id
 * @returns {Promise<void>}
 */
async function insertPendingRow(content, tempId) {
	hubStore.composerPendingId = tempId
	const row = pendingRowFromComposer(content, tempId)
	const container = document.getElementById('hub-messages')
	if (!container) return
	hubStore.channelMessagesSource = mergeIncrementalChannelBatch(hubStore.channelMessagesSource, [row])
	refreshChannelView()
	syncChannelActionsContext()
	if (container.querySelector('.hub-empty')) container.innerHTML = ''
	if (!hubStore.channelMessagePipeline) initChannelVirtualList(container)
	const visible = hubStore.channelMessages.find(m => String(m.eventId) === tempId)
	if (visible) await hubStore.channelMessagePipeline.appendItem(visible, true)
	decorateRenderedMessages(container, true)
}

/**
 * POST 成功后替换 pending 行。
 * @param {string} tempId 临时 id
 * @param {object} event DAG 事件
 * @returns {Promise<void>}
 */
async function confirmPendingRow(tempId, event) {
	hubStore.composerPendingId = null
	const realRow = channelRowFromPostedEvent(event)
	const realId = String(realRow.eventId)
	const container = document.getElementById('hub-messages')
	hubStore.channelMessagesSource = mergeIncrementalChannelBatch(
		hubStore.channelMessagesSource.filter(m => String(m.eventId) !== tempId),
		[realRow],
	)
	refreshChannelView()
	if (hubStore.channelMessagePipeline)
		await hubStore.channelMessagePipeline.refresh()
	syncChannelActionsContext()
	updateLastMessageId()
	if (container) decorateRenderedMessages(container, false)
}

/**
 * 发送失败时移除 pending 行。
 * @param {string} tempId 临时 id
 * @returns {Promise<void>}
 */
async function removePendingRow(tempId) {
	hubStore.composerPendingId = null
	const idx = hubStore.channelMessages.findIndex(m => String(m.eventId) === tempId)
	hubStore.channelMessagesSource = hubStore.channelMessagesSource.filter(m => String(m.eventId) !== tempId)
	refreshChannelView()
	if (idx >= 0 && hubStore.channelMessagePipeline)
		await hubStore.channelMessagePipeline.deleteItem(idx)
	else if (hubStore.channelMessagePipeline)
		await hubStore.channelMessagePipeline.refresh()
	syncChannelActionsContext()
}

/**
 * 单条消息增量写入虚表（唯一 DOM 更新入口）。
 * @param {object} message API/WS 消息行
 * @param {{ scroll?: boolean }} [options] 是否滚动到底
 * @returns {Promise<void>}
 */
async function applyIncomingMessage(message, { scroll = false } = {}) {
	const container = document.getElementById('hub-messages')
	if (!container) return

	const eventId = String(message.eventId || '')
	if (!eventId) return

	if (getActiveVolatileStreamIds().includes(eventId) && !isChannelMessageGenerating(message))
		dismissVolatileStreamPreview(eventId, { notifyEnd: false })

	const hadInSource = hubStore.channelMessagesSource.some(m => String(m.eventId) === eventId)
	hubStore.channelMessagesSource = mergeIncrementalChannelBatch(hubStore.channelMessagesSource, [message])
	refreshChannelView()

	if (container.querySelector('.hub-empty')) container.innerHTML = ''
	if (!hubStore.channelMessagePipeline) initChannelVirtualList(container)

	const viewIdx = hubStore.channelMessages.findIndex(m => String(m.eventId) === eventId)
	const row = viewIdx >= 0 ? hubStore.channelMessages[viewIdx] : null
	if (row) 
		if (hadInSource)
			await hubStore.channelMessagePipeline.replaceItem(viewIdx, row)
		else
			await hubStore.channelMessagePipeline.appendItem(row, scroll)
	
	else
		await hubStore.channelMessagePipeline.refresh()

	if (isChannelMessageGenerating(message))
		void catchUpVolatileStreamFromServer(eventId)

	if (!isThreadDrawerOpen()) syncChannelActionsContext()
	updateLastMessageId()
	decorateRenderedMessages(container, scroll)
}

/**
 * @param {object[]} batch 本轮 API 返回行
 * @param {{ scroll?: boolean }} [options] 是否滚动到底
 * @returns {Promise<void>}
 */
async function applyIncomingMessageBatch(batch, { scroll = false } = {}) {
	for (const message of batch)
		await applyIncomingMessage(message, { scroll: false })
	const container = document.getElementById('hub-messages')
	if (container && scroll) scrollToBottom()
}

/**
 * @param {{ immediate?: boolean }} [options] `immediate` 时跳过防抖（流式占位须尽快入列）
 * @returns {void}
 */
export function scheduleChannelIncrementalRefresh({ immediate = false } = {}) {
	if (immediate) {
		if (channelIncrementalDebounceTimer) {
			clearTimeout(channelIncrementalDebounceTimer)
			channelIncrementalDebounceTimer = null
		}
		void refreshChannelMessagesIncremental()
		return
	}
	if (channelIncrementalDebounceTimer) clearTimeout(channelIncrementalDebounceTimer)
	channelIncrementalDebounceTimer = setTimeout(() => {
		channelIncrementalDebounceTimer = null
		void refreshChannelMessagesIncremental()
	}, 200)
}

/**
 * 用服务端物化行更新单条消息（流式终稿 / 编辑）。
 * @param {string} targetId 目标 message eventId
 * @returns {Promise<void>}
 */
export async function applyChannelMessageEdit(targetId) {
	const id = String(targetId || '').trim()
	if (!id || !hubStore.currentGroupId || !hubStore.currentChannelId) return
	dismissVolatileStreamPreview(id, { notifyEnd: false })

	const { messages } = await getChannelMessages(
		hubStore.currentGroupId,
		hubStore.currentChannelId,
		{ since: id, limit: 20 },
	)
	const row = messages.find(m => String(m.eventId) === id)
	if (!row) {
		scheduleChannelIncrementalRefresh({ immediate: true })
		return
	}
	await replaceChannelMessageRow(id, row)
}

/**
 * 从展示列表移除已删除消息。
 * @param {string} targetId 被删 message eventId
 * @returns {Promise<void>}
 */
export async function applyChannelMessageDelete(targetId) {
	const id = String(targetId || '').trim()
	if (!id) return
	dismissVolatileStreamPreview(id, { notifyEnd: false })
	const idx = hubStore.channelMessages.findIndex(m => String(m.eventId) === id)
	if (idx < 0) return
	hubStore.channelMessagesSource = hubStore.channelMessagesSource.filter(m => String(m.eventId) !== id)
	const container = document.getElementById('hub-messages')
	refreshChannelView()
	if (hubStore.channelMessagePipeline)
		await hubStore.channelMessagePipeline.deleteItem(idx)
	syncChannelActionsContext()
	updateLastMessageId()
	if (container) decorateRenderedMessages(container, false)
}

/**
 * @param {string} eventId 消息 eventId
 * @param {object} row 服务端物化行
 * @returns {Promise<void>}
 */
async function replaceChannelMessageRow(eventId, row) {
	const id = String(eventId)
	const sourceIdx = hubStore.channelMessagesSource.findIndex(m => String(m.eventId) === id)
	if (sourceIdx >= 0)
		hubStore.channelMessagesSource[sourceIdx] = row
	else
		hubStore.channelMessagesSource = mergeIncrementalChannelBatch(hubStore.channelMessagesSource, [row])
	refreshChannelView()

	const container = document.getElementById('hub-messages')
	if (!container) return
	if (container.querySelector('.hub-empty')) container.innerHTML = ''
	if (!hubStore.channelMessagePipeline) initChannelVirtualList(container)
	const viewIdx = hubStore.channelMessages.findIndex(m => String(m.eventId) === id)
	const viewRow = viewIdx >= 0 ? hubStore.channelMessages[viewIdx] : null
	if (viewRow && hubStore.channelMessagePipeline) {
		const inPipeline = container.querySelector(messageIdSelector(id))
		if (inPipeline)
			await hubStore.channelMessagePipeline.replaceItem(viewIdx, viewRow)
		else
			await hubStore.channelMessagePipeline.appendItem(viewRow, false)
	}
	else if (hubStore.channelMessagePipeline)
		await hubStore.channelMessagePipeline.refresh()
	syncChannelActionsContext()
	updateLastMessageId()
	decorateRenderedMessages(container, false)
}

/** @returns {Promise<void>} */
export async function refreshChannelMessagesIncremental() {
	const searchActive = !!hubStore.channelSearchQuery
	if (!hubStore.currentGroupId || !hubStore.currentChannelId) return
	const chType = hubStore.currentState?.channels?.[hubStore.currentChannelId]?.type || 'text'
	if (chType === 'list' || chType === 'streaming') return

	const container = document.getElementById('hub-messages')
	if (!container) return

	const options = { limit: 50 }
	if (hubStore.lastMessageId)
		options.since = hubStore.lastMessageId

	const { messages, reactionEvents } = await getChannelMessages(
		hubStore.currentGroupId,
		hubStore.currentChannelId,
		options,
	)
	const reactionSig = reactionEvents.map(e => e.eventId).sort().join(',')
	if (!messages.length && !reactionSig) return

	if (searchActive) {
		if (reactionSig !== hubStore.reactionEventsEtag) {
			hubStore.reactionEventsEtag = reactionSig
			hubStore.channelReactionEvents = reactionEvents
		}
		if (messages.length) {
			hubStore.channelMessagesSource = mergeIncrementalChannelBatch(
				hubStore.channelMessagesSource,
				messages,
			)
			updateLastMessageId()
		}
		return
	}

	if (container.querySelector('.hub-empty')) container.innerHTML = ''

	const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100
	if (reactionSig !== hubStore.reactionEventsEtag) {
		hubStore.reactionEventsEtag = reactionSig
		await patchReactionRows(container, reactionEvents)
		if (!messages.length) return
	}
	hubStore.channelReactionEvents = reactionEvents
	await applyIncomingMessageBatch(messages, { scroll: nearBottom })
}

/** @returns {void} */
export function refreshHubHeaderButtons() {
	const filesButton = document.getElementById('hub-header-files-button')
	if (filesButton)
		if (hubStore.currentMode === 'groups' && hubStore.currentGroupId && hubStore.currentState?.isMember)
			filesButton.removeAttribute('hidden')
		else filesButton.setAttribute('hidden', '')

	const settingsButton = document.getElementById('hub-header-settings-button')
	if (settingsButton)
		if (hubStore.currentMode === 'groups' && hubStore.currentGroupId)
			settingsButton.setAttribute('hidden', '')
		else settingsButton.removeAttribute('hidden')
}

/** @returns {void} */
export function enableComposer() {
	const input = document.getElementById('hub-message-input')
	const channelName = hubStore.currentState?.channels?.[hubStore.currentChannelId]?.name || hubStore.currentChannelId || ''
	input.disabled = false
	input.dataset.channel = channelName
	input.removeAttribute('data-i18n')
	input.setAttribute('data-i18n', 'chat.hub.composer')
	for (const id of ['hub-emoji-button', 'hub-upload-button', 'hub-voice-button', 'hub-photo-button', 'hub-sticker-button', 'hub-vote-button', 'hub-send-button']) {
		const el = document.getElementById(id)
		if (el) el.disabled = false
	}
	refreshHubHeaderButtons()
}

/**
 * @param {string} [i18nKey] placeholder 的 i18n 键
 * @returns {void}
 */
export function disableComposer(i18nKey = 'chat.hub.composerDisabled') {
	const input = document.getElementById('hub-message-input')
	input.disabled = true
	input.dataset.i18n = i18nKey
	delete input.dataset.channel
	for (const id of ['hub-emoji-button', 'hub-upload-button', 'hub-voice-button', 'hub-photo-button', 'hub-sticker-button', 'hub-vote-button', 'hub-send-button']) {
		const el = document.getElementById(id)
		if (el) el.disabled = true
	}
	refreshHubHeaderButtons()
}

/**
 * @param {string} content 消息正文
 * @returns {Promise<void>}
 */
export async function sendCurrentMessage(content) {
	if (!hubStore.currentGroupId || !hubStore.currentChannelId)
		throw new Error('no channel selected')
	await waitForGroupWebSocketOpen(hubStore.currentGroupId, hubStore.currentChannelId)
	const files = [...selectedFiles]
	const tempId = `pending:${crypto.randomUUID()}`
	await insertPendingRow(content, tempId)
	try {
		const event = await sendGroupMessage(hubStore.currentGroupId, hubStore.currentChannelId, content, files)
		clearSelectedFiles()
		await confirmPendingRow(tempId, event)
	}
	catch (error) {
		await removePendingRow(tempId)
		throw error
	}
}

/** @returns {Promise<void>} */
export async function submitComposer() {
	const input = document.getElementById('hub-message-input')
	if (input.disabled) return
	await stopVoiceIfRecording()
	const content = input.value.trim()
	if (!content && !selectedFiles.length) return
	if (!hubStore.currentGroupId || !hubStore.currentChannelId) return
	input.value = ''
	if (input instanceof HTMLTextAreaElement)
		input.style.height = 'auto'
	try {
		await sendCurrentMessage(content)
	}
	catch (err) {
		showToastI18n('error', 'chat.hub.sendFailed', { error: err.message })
		input.value = content
		if (input instanceof HTMLTextAreaElement)
			input.dispatchEvent(new Event('input', { bubbles: true }))
	}
}
