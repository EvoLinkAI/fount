/**
 * 【文件】federation/gossip.mjs
 * 【职责】联邦 gossip 协议：发起 wantIds 请求、处理 gossip_response、去重转发、等待补洞完成，并校验远端 checkpoint。
 * 【原理】requestMissingEventsGossip 先读本地，缺失则经 room.sendGossipRequest 带 archiveSummary 与 ttl；邻居在 room 内应答或继续转发（ttl 递减）。handleGossipResponse 仅接受 requesterId=本 nodeId 的批次，appendValidatedRemoteEvent 后 notifyGossipWaiters。入站请求侧 dedupe 与 want_ids 限速在 room 与 scripts/p2p/want_ids 协作。
 * 【数据结构】请求 { wantIds, ttl, requesterId, archiveSummary }；响应 { events, checkpoint?, channelHistories? }；pendingGossipRequests 按排序后的 wantIds 键等待。
 * 【关联】room.mjs、archiveHandshake.mjs、registry.mjs、peerPool.mjs、checkpointVerifier.mjs、index catchUpGroupFromPeers。
 */
import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { resolveFederationPoolLimits } from '../../../../../../../scripts/p2p/peer_pool.mjs'
import {
	batchWantIds,
	takeOutgoingWantIdsSlot,
} from '../../../../../../../scripts/p2p/want_ids.mjs'
import { pickFederationTargetPeerIds } from '../governance/peerPool.mjs'
import { verifyRemoteCheckpoint } from '../lib/checkpointVerifier.mjs'
import { eventsPath } from '../lib/paths.mjs'
import { extractInboundSignedEvent, isPlainObject } from '../lib/wireIngress.mjs'

import { loadLocalFederationArchive, wireArchiveSummary } from './archiveHandshake.mjs'
import { loadFederationGroupSettings, requireDagDeps } from './deps.mjs'
import { pendingGossipRequests } from './registry.mjs'

const gossipRequestDedupe = new Map()
const GOSSIP_DEDUPE_MS = 30_000
const GOSSIP_RESPONSE_WAIT_MS = 3000

/**
 * 从群设置推导 wantIds 限速参数。
 * @param {object} groupSettings 群设置
 * @returns {object} 传入 want_ids 模块的 limits
 */
export function wantIdsLimitsFromSettings(groupSettings) {
	const budget = Number(groupSettings?.wantIdsBudget)
	return {
		inMaxBatch: Number.isFinite(budget) ? Math.max(4, Math.min(128, budget)) : undefined,
		outMaxBatch: Number.isFinite(budget) ? Math.max(4, Math.min(128, budget)) : undefined,
	}
}

/**
 * @param {string} dedupeKey 去重键
 * @returns {boolean} 首次处理为 true
 */
export function takeGossipRequestSlot(dedupeKey) {
	const now = Date.now()
	if (gossipRequestDedupe.size > 2000)
		for (const [key, expiresAt] of gossipRequestDedupe)
			if (expiresAt < now - GOSSIP_DEDUPE_MS) gossipRequestDedupe.delete(key)
	if (gossipRequestDedupe.has(dedupeKey)) return false
	gossipRequestDedupe.set(dedupeKey, now)
	return true
}

/**
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {string[]} wantIds 缺失事件 ID 列表
 * @returns {string} pending gossip 等待表键
 */
function gossipWaitKey(username, groupId, wantIds) {
	return `${username}\0${groupId}\0${[...wantIds].sort().join(',')}`
}

/**
 * 注册 gossip 响应等待（最长 `GOSSIP_RESPONSE_WAIT_MS`）。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {string[]} wantIds 请求的缺失 ID 列表
 * @returns {Promise<void>}
 */
function waitForGossipProgress(username, groupId, wantIds) {
	const key = gossipWaitKey(username, groupId, wantIds)
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			removeGossipWaiter(key, resolve, timer)
			resolve()
		}, GOSSIP_RESPONSE_WAIT_MS)
		let waiters = pendingGossipRequests.get(key)
		if (!waiters) {
			waiters = []
			pendingGossipRequests.set(key, waiters)
		}
		waiters.push({ resolve, timer })
	})
}

/**
 * @param {string} key gossipWaitKey
 * @param {() => void} resolve Promise resolve
 * @param {ReturnType<typeof setTimeout>} timer 超时句柄
 * @returns {void}
 */
function removeGossipWaiter(key, resolve, timer) {
	clearTimeout(timer)
	const waiters = pendingGossipRequests.get(key)
	if (!waiters) return
	const index = waiters.findIndex(entry => entry.resolve === resolve && entry.timer === timer)
	if (index >= 0) waiters.splice(index, 1)
	if (!waiters.length) pendingGossipRequests.delete(key)
}

/**
 * 立即结束某次 gossip 等待。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {string[]} wantIds 与注册时相同的缺失 ID 列表
 * @returns {void}
 */
export function forceResolveGossipWait(username, groupId, wantIds) {
	const key = gossipWaitKey(username, groupId, wantIds)
	const waiters = pendingGossipRequests.get(key)
	if (!waiters?.length) return
	for (const { resolve, timer } of [...waiters]) {
		clearTimeout(timer)
		removeGossipWaiter(key, resolve, timer)
		resolve()
	}
}

/**
 * 收到 gossip 响应后唤醒等待方。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {ReadonlySet<string>} receivedIds 本批响应中的事件 ID
 * @returns {void}
 */
export function notifyGossipWaiters(username, groupId, receivedIds) {
	if (!receivedIds.size) return
	const prefix = `${username}\0${groupId}\0`
	for (const [key, waiters] of [...pendingGossipRequests]) {
		if (!key.startsWith(prefix)) continue
		const idsPart = key.slice(prefix.length)
		if (!idsPart) continue
		const wanted = new Set(idsPart.split(','))
		let hit = false
		for (const eventId of receivedIds) 
			if (wanted.has(eventId)) {
				hit = true
				break
			}
		
		if (!hit) continue
		for (const { resolve, timer } of [...waiters]) {
			clearTimeout(timer)
			removeGossipWaiter(key, resolve, timer)
			resolve()
		}
	}
}

/**
 * 处理入站 `gossip_response` 并唤醒等待方。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {unknown} data `gossip_response` 载荷
 * @returns {Promise<void>}
 */
export async function handleGossipResponse(username, groupId, data) {
	const { nodeId, appendValidatedRemoteEvent } = requireDagDeps()
	if (!isPlainObject(data)) return
	if (data.requesterId !== nodeId) return

	const rawList = data.events
	const {channelHistories} = data
	if (!Array.isArray(rawList) && !isPlainObject(channelHistories)) return

	const remoteCheckpoint = data.checkpoint
	if (isPlainObject(remoteCheckpoint)) {
		const checkpointResult = await verifyRemoteCheckpoint(remoteCheckpoint, undefined)
			.catch(() => ({ valid: false, reason: 'exception' }))
		if (!checkpointResult.valid) {
			console.warn(`federation: remote checkpoint invalid (${checkpointResult.reason}), rejecting gossip batch`)
			return
		}
	}

	const receivedIds = new Set()
	if (Array.isArray(rawList))
		for (const rawEvent of rawList) {
			const signedEvent = extractInboundSignedEvent(rawEvent, groupId)
			if (!signedEvent) continue
			receivedIds.add(signedEvent.id)
			await appendValidatedRemoteEvent(username, groupId, signedEvent, { logFailures: false })
		}

	if (isPlainObject(channelHistories)) {
		const { mergeChannelHistories } = await import('../dag/queries.mjs')
		await mergeChannelHistories(username, groupId, channelHistories)
	}
	notifyGossipWaiters(username, groupId, receivedIds)
}

/**
 * 按 ID 查询本地事件，可选经联邦 gossip 补洞。
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @param {{ wantIds?: string[], peerEvents?: unknown[], awaitGossip?: boolean }} [query] 查询与可选对端事件
 * @returns {Promise<{ found: boolean, events: object[], stillMissing: string[], mergedFromPeer: number, rateLimited: boolean }>} 补洞结果
 */
export async function requestMissingEventsGossip(username, groupId, query = {}) {
	const { nodeId, readJsonl, appendValidatedRemoteEvent } = requireDagDeps()
	const wantIds = [...new Set(
		(query.wantIds || []).filter(isHex64),
	)]

	let mergedFromPeer = 0
	for (const rawEvent of query.peerEvents || []) {
		const signedEvent = extractInboundSignedEvent(rawEvent, groupId)
		if (!signedEvent) continue
		if (await appendValidatedRemoteEvent(username, groupId, signedEvent, { logFailures: false }) === 'ok')
			mergedFromPeer++
	}

	/**
	 * @returns {Promise<{ filled: object[], stillMissing: string[] }>} 本地已命中与仍缺 id
	 */
	const readFilled = async () => {
		const events = await readJsonl(eventsPath(username, groupId))
		const eventsById = new Map(events.map(event => [event.id, event]))
		return {
			filled: wantIds.map(id => eventsById.get(id)).filter(Boolean),
			stillMissing: wantIds.filter(id => !eventsById.has(id)),
		}
	}

	let { filled, stillMissing } = await readFilled()
	let rateLimited = false

	if (stillMissing.length && query.awaitGossip !== false) {
		const waitPromise = waitForGossipProgress(username, groupId, stillMissing)
		const { ensureFederationRoom } = await import('./room.mjs')
		const slot = await ensureFederationRoom(username, groupId)
		if (!slot?.sendGossipRequest) 
			forceResolveGossipWait(username, groupId, stillMissing)
		
		else {
			const groupSettings = await loadFederationGroupSettings(username, groupId)
			if (!takeOutgoingWantIdsSlot(username, groupId, wantIdsLimitsFromSettings(groupSettings))) {
				rateLimited = true
				forceResolveGossipWait(username, groupId, stillMissing)
			}
			else {
				const localArchive = await loadLocalFederationArchive(username, groupId, readJsonl)
				const { gossipTtl, wantIdsBudget } = resolveFederationPoolLimits(groupSettings)
				const targets = await pickFederationTargetPeerIds(
					username,
					groupId,
					slot.getRoster?.() || [],
					groupSettings,
					nodeId,
				)
				try {
					const payload = {
						wantIds: batchWantIds(stillMissing, wantIdsBudget),
						ttl: gossipTtl,
						requesterId: nodeId,
						archiveSummary: wireArchiveSummary(localArchive.summary),
					}
					if (targets.length)
						for (const peerId of targets)
							slot.sendGossipRequest(payload, peerId)
					else
						slot.sendGossipRequest(payload, null)
				}
				catch (error) {
					console.error('federation: gossip_request failed', error)
					forceResolveGossipWait(username, groupId, stillMissing)
				}
				await waitPromise.catch(console.error)
			}
		}
		;({ filled, stillMissing } = await readFilled())
	}

	return {
		found: !wantIds.length || !stillMissing.length,
		events: filled,
		stillMissing,
		mergedFromPeer,
		rateLimited,
	}
}
