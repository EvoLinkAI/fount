/**
 * 【文件】federation/channelHistory.mjs
 * 【职责】经 Trystero channel_history_want/response 向联邦邻居拉取频道 JSONL 历史，并合并入本地频道消息存储。
 * 【原理】广播 want（requesterId=本 nodeId），在 pendingChannelHistory 注册 2s 等待；入站 response 校验 requesterId 后 resolve 并 mergeChannelHistoryRows。新鲜加入时 room 亦可在 gossip_response 附带 channelHistories。
 * 【数据结构】want { requestId, channelId, before?, limit, requesterId }；等待键 username\0groupId\0channelId\0requestId。
 * 【关联】room.mjs、registry.mjs、deps.mjs、dag/queries.mjs；与 gossip 并行互补的频道级补全通道。
 */
import { randomUUID } from 'node:crypto'

import { isPlainObject } from '../lib/wireIngress.mjs'

import { requireDagDeps } from './deps.mjs'
import { EVENT_ID_HEX, pendingChannelHistory } from './registry.mjs'

const CHANNEL_HISTORY_WAIT_MS = 2000

/**
 * @param {string} username 用户名
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {string} requestId 请求 id
 * @returns {string} 等待表键
 */
function channelHistoryWaitKey(username, groupId, channelId, requestId) {
	return `${username}\0${groupId}\0${channelId}\0${requestId}`
}

/**
 * 向联邦邻居广播频道历史问询并等待应答。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {{ before?: string, limit?: number }} [opts] 游标与条数
 * @returns {Promise<object[]>} 对端返回的消息行
 */
export async function requestChannelHistoryFromPeers(username, groupId, channelId, opts = {}) {
	const { ensureFederationRoom } = await import('./room.mjs')
	const slot = await ensureFederationRoom(username, groupId)
	if (!slot?.sendChannelHistoryWant) return []

	const { nodeId } = requireDagDeps()
	const requestId = randomUUID()
	const key = channelHistoryWaitKey(username, groupId, channelId, requestId)
	const waitPromise = new Promise(resolve => {
		const timer = setTimeout(() => {
			pendingChannelHistory.delete(key)
			resolve([])
		}, CHANNEL_HISTORY_WAIT_MS)
		pendingChannelHistory.set(key, {
			/**
			 * @param {object[]} rows 对端消息行
			 * @returns {void}
			 */
			resolve: rows => {
				clearTimeout(timer)
				pendingChannelHistory.delete(key)
				resolve(Array.isArray(rows) ? rows : [])
			},
			timer,
		})
	})

	const limit = Math.min(500, Math.max(1, Number(opts.limit) || 50))
	const before = EVENT_ID_HEX.test(String(opts.before || '')) ? opts.before : null
	try {
		slot.sendChannelHistoryWant({
			requestId,
			channelId,
			before,
			limit,
			requesterId: nodeId,
		}, null)
	}
	catch (error) {
		console.error('federation: channel_history_want send failed', error)
		pendingChannelHistory.delete(key)
		return []
	}
	return waitPromise
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {unknown} data `channel_history_response` 载荷
 * @returns {Promise<void>}
 */
export async function handleChannelHistoryResponse(username, groupId, data) {
	if (!isPlainObject(data)) return
	const { nodeId } = requireDagDeps()
	if (data.requesterId !== nodeId) return

	const requestId = String(data.requestId || '').trim()
	const channelId = String(data.channelId || '').trim()
	if (!requestId || !channelId) return

	const messages = Array.isArray(data.messages) ? data.messages : []
	const pending = pendingChannelHistory.get(channelHistoryWaitKey(username, groupId, channelId, requestId))
	if (pending) pending.resolve(messages)

	if (messages.length) {
		const { mergeChannelHistoryRows } = await import('../dag/queries.mjs')
		await mergeChannelHistoryRows(username, groupId, channelId, messages)
	}
}
