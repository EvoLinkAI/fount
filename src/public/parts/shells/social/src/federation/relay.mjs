import { randomUUID } from 'node:crypto'

import { requireTrustGraphProvider } from '../../../../../../../scripts/p2p/trust_graph_registry.mjs'
import { requireDagDeps } from '../../../chat/src/chat/federation/deps.mjs'
import { ingestRemoteTimelineEvent } from '../timeline/sync.mjs'

/** @type {Map<string, { resolve: (v: object) => void, timer: ReturnType<typeof setTimeout> }>} */
const pendingRpc = new Map()

/**
 * 本地 append 后向 Top-K 邻居 fanout 时间线事件。
 * @param {string} username 用户
 * @param {string} entityHash owner
 * @param {object} signedEvent 签名事件
 * @returns {Promise<number>} 发送次数
 */
export async function publishTimelineEvent(username, entityHash, signedEvent) {
	const { nodeId } = requireDagDeps()
	return requireTrustGraphProvider('chat').fanoutToTopNodes(username, 'social_timeline_put', {
		nodeId,
		timelineEntityHash: entityHash.toLowerCase(),
		event: signedEvent,
	}, 8)
}

/**
 * 入站 social_timeline_put。
 * @param {string} username 用户
 * @param {object} payload 载荷
 * @returns {Promise<boolean>} 是否成功写入
 */
export async function ingestSocialTimelinePut(username, payload) {
	const entityHash = String(payload?.timelineEntityHash || '').toLowerCase()
	const event = payload?.event
	if (!entityHash || !event?.id) return false
	return ingestRemoteTimelineEvent(username, entityHash, event)
}

/**
 * 向邻居发起 social RPC 并等待聚合。
 * @param {string} username 用户
 * @param {object} rpc RPC 体
 * @param {number} [timeoutMs=2500] 等待邻居响应的超时毫秒
 * @returns {Promise<object[]>} 邻居 RPC 响应列表
 */
export async function requestSocialRpcFromNetwork(username, rpc, timeoutMs = 2500) {
	const requestId = randomUUID()
	const { nodeId } = requireDagDeps()
	/** @type {object[]} */
	const responses = []
	const waitForResponses = new Promise(resolve => {
		const timer = setTimeout(() => {
			pendingRpc.delete(requestId)
			resolve(responses)
		}, timeoutMs)
		pendingRpc.set(requestId, {
			/**
			 * 收集单条 RPC 响应。
			 * @param {object} response 邻居响应体
			 * @returns {void}
			 */
			resolve: (response) => {
				responses.push(response)
			},
			timer,
		})
	})
	await requireTrustGraphProvider('chat').fanoutToTopNodes(username, 'social_rpc', { nodeId, requestId, rpc }, 6)
	return waitForResponses
}

/**
 * 处理入站 social_rpc 并回复。
 * @param {string} username 用户
 * @param {object} payload 请求
 * @param {(response: object, peerId: string) => void} sendResponse 发送回调
 * @param {string} peerId 对端
 * @returns {Promise<void>}
 */
export async function handleIncomingSocialRpc(username, payload, sendResponse, peerId) {
	const rpc = payload?.rpc
	if (!rpc?.type) return
	const { handleSocialRpc } = await import('../discovery.mjs')
	const response = await handleSocialRpc(username, rpc)
	if (response) sendResponse({ requestId: payload.requestId, response }, peerId)
}

/**
 * 处理入站 social_rpc_response。
 * @param {object} payload 响应
 * @returns {void}
 */
export function handleIncomingSocialRpcResponse(payload) {
	const pending = pendingRpc.get(String(payload?.requestId || ''))
	if (!pending) return
	if (payload?.response) pending.resolve(payload.response)
}

/**
 * 探索页：合并本地 + 邻居 RPC 结果。
 * @param {string} username 用户
 * @param {object} rpc RPC 请求体
 * @returns {Promise<object>} 合并结果
 */
export async function discoverWithNetwork(username, rpc) {
	const { handleSocialRpc } = await import('../discovery.mjs')
	const local = await handleSocialRpc(username, rpc)
	const remote = await requestSocialRpcFromNetwork(username, rpc)
	const merged = { ...local }
	if (rpc.type === 'social_discover_request') {
		const accounts = [...local.accounts]
		for (const row of remote)
			for (const account of row.accounts)
				if (!accounts.some(existing => existing.entityHash === account.entityHash))
					accounts.push(account)
		merged.accounts = accounts.slice(0, rpc.n || 20)
	}
	if (rpc.type === 'social_post_discover_request') {
		const posts = [...local.posts]
		for (const row of remote)
			for (const post of row.posts)
				if (!posts.some(existing => existing.postId === post.postId && existing.entityHash === post.entityHash))
					posts.push(post)
		merged.posts = posts.slice(0, rpc.n || 20)
	}
	return merged
}

/**
 * 从 mailbox 导入指定 entity 的时间线事件（关注时调用）。
 * @param {string} username 用户
 * @param {string} entityHash owner
 * @returns {Promise<number>} 导入条数
 */
export async function syncTimelineForEntity(username, entityHash) {
	const { syncTimelineFromMailbox } = await import('../timeline/sync.mjs')
	const { reprocessFollowApproveVaults } = await import('../gsh/followApproveImport.mjs')
	const fromMailbox = await syncTimelineFromMailbox(username, entityHash)
	await reprocessFollowApproveVaults(username, entityHash)
	return fromMailbox
}
