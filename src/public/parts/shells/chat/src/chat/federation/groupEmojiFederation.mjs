/**
 * 【文件】federation/groupEmojiFederation.mjs
 * 【职责】群自定义表情经 Trystero fed_emoji_want/data 在 P2P 邻居间拉取与缓存，避免仅靠 HTTP 上传侧存储。
 * 【原理】attachFedEmojiHandlers 在 room join 时注册；本地有二进制则响应 dataUrl，请求方 persistGroupEmojiFromDataUrl。与 fed_chunk 类似采用 pendingFetches + 超时，拉黑 peer 不响应。
 * 【数据结构】载荷 { emojiId, dataUrl?, mimeType? }；等待键 username\0groupId\0emojiId。
 * 【关联】room.mjs、group/groupEmojis.mjs、wireIngress.mjs、governance/peers 拉黑检查。
 */
import {
	bufferToDataUrl,
	getGroupEmojiEntry,
	persistGroupEmojiFromDataUrl,
	readGroupEmojiBinary,
} from '../../group/groupEmojis.mjs'
import { isPlainObject } from '../lib/wireIngress.mjs'

const FETCH_TIMEOUT_MS = 14_000
const EMOJI_WANT_MAX_PER_MIN = 30
const EMOJI_WANT_BUCKET_KEY = 'emoji_want'

/** @type {Map<string, { resolve: (v: { dataUrl: string, mimeType: string }) => void, timer: ReturnType<typeof setTimeout> }>} */
const pendingFetches = new Map()

/** @type {Map<string, { count: number, windowStart: number }>} */
const emojiWantBuckets = new Map()

/**
 * @param {string} bucketKey 房间键
 * @returns {boolean} 是否允许 want
 */
function consumeEmojiWant(bucketKey) {
	const now = Date.now()
	let bucket = emojiWantBuckets.get(bucketKey)
	if (!bucket || now - bucket.windowStart >= 60_000)
		bucket = { count: 0, windowStart: now }
	if (bucket.count >= EMOJI_WANT_MAX_PER_MIN) {
		emojiWantBuckets.set(bucketKey, bucket)
		return false
	}
	bucket.count++
	emojiWantBuckets.set(bucketKey, bucket)
	return true
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} emojiId 表情 ID
 * @returns {string} 等待键
 */
function waitKey(username, groupId, emojiId) {
	return `${username}\0${groupId}\0${emojiId}`
}

/**
 * 处理入站 `fed_emoji_want`：本地有则回复 `fed_emoji_data`。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {unknown} data 载荷
 * @param {string} peerId 对端
 * @param {(payload: unknown, peerId: string) => void} sendEmojiData 发送 fed_emoji_data
 * @param {(id: string) => boolean} isBlockedPeer 拉黑检查
 * @param {Map<string, string>} peerToNode peer → nodeId
 * @returns {Promise<void>}
 */
export async function handleFedEmojiWant(username, groupId, data, peerId, sendEmojiData, isBlockedPeer, peerToNode) {
	if (!isPlainObject(data)) return
	if (!consumeEmojiWant(waitKey(username, groupId, EMOJI_WANT_BUCKET_KEY))) return
	const remoteNode = peerToNode.get(peerId)
	if (remoteNode && isBlockedPeer(remoteNode)) return
	const emojiId = String(data.emojiId || '').trim()
	if (!emojiId) return
	const local = await readGroupEmojiBinary(username, groupId, emojiId)
	if (!local) return
	const dataUrl = bufferToDataUrl(local.buffer, local.mimeType)
	try {
		sendEmojiData({ emojiId, dataUrl, mimeType: local.mimeType }, peerId)
	}
	catch { /* ignore */ }
}

/**
 * 处理入站 `fed_emoji_data`：写入本地并兑现等待中的 Promise。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {unknown} data 载荷
 * @returns {Promise<void>}
 */
export async function handleFedEmojiData(username, groupId, data) {
	if (!isPlainObject(data)) return
	const emojiId = String(data.emojiId || '').trim()
	const dataUrl = String(data.dataUrl || '').trim()
	const mimeType = String(data.mimeType || 'image/png')
	if (!emojiId || !dataUrl.startsWith('data:')) return
	const key = waitKey(username, groupId, emojiId)
	const pending = pendingFetches.get(key)
	if (pending) {
		clearTimeout(pending.timer)
		pendingFetches.delete(key)
		pending.resolve({ dataUrl, mimeType })
	}
	const existing = await getGroupEmojiEntry(username, groupId, emojiId)
	if (!existing)
		await persistGroupEmojiFromDataUrl(username, groupId, emojiId, dataUrl, mimeType).catch(() => {})
}

/**
 * 向联邦邻居广播索要群表情。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} emojiId 表情 ID
 * @param {object | null} slot 联邦房间槽
 * @returns {Promise<{ dataUrl: string, mimeType: string } | null>} 对端返回的 data URL，超时为 null
 */
export async function requestGroupEmojiFromPeers(username, groupId, emojiId, slot) {
	if (!slot) return null
	const roster = slot.getRoster()
	if (!roster.length) return null
	if (!consumeEmojiWant(waitKey(username, groupId, EMOJI_WANT_BUCKET_KEY))) return null
	const key = waitKey(username, groupId, emojiId)
	return await new Promise(resolve => {
		const timer = setTimeout(() => {
			pendingFetches.delete(key)
			resolve(null)
		}, FETCH_TIMEOUT_MS)
		pendingFetches.set(key, { resolve, timer })
		const payload = { emojiId }
		for (const { peerId } of roster)
			try { slot.sendToPeer(peerId, 'fed_emoji_want', payload) }
			catch { /* ignore */ }
	})
}

/**
 * 上传后向邻居推送群表情数据（best-effort）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} emojiId 表情 ID
 * @param {object | null} slot 联邦槽
 * @returns {Promise<void>}
 */
export async function replicateGroupEmojiToFederation(username, groupId, emojiId, slot) {
	if (!slot) return
	const roster = slot.getRoster()
	if (!roster.length) return
	const local = await readGroupEmojiBinary(username, groupId, emojiId)
	if (!local) return
	const dataUrl = bufferToDataUrl(local.buffer, local.mimeType)
	const payload = { emojiId, dataUrl, mimeType: local.mimeType }
	for (const { peerId } of roster)
		try { slot.sendToPeer(peerId, 'fed_emoji_data', payload) }
		catch { /* ignore */ }
}

/**
 * 在联邦房间注册 `fed_emoji_want` / `fed_emoji_data` 处理器。
 * @param {{
 *   username: string,
 *   groupId: string,
 *   room: object,
 *   peerToNode: Map<string, string>,
 *   isBlockedPeer: (id: string) => boolean,
 *   slot: object,
 * }} fedRoom 联邦房间上下文
 * @returns {void}
 */
export function attachFedEmojiHandlers(fedRoom) {
	const { username, groupId, room, peerToNode, isBlockedPeer, slot } = fedRoom
	const [, getEmojiWant] = room.makeAction('fed_emoji_want')
	const [sendEmojiData, getEmojiData] = room.makeAction('fed_emoji_data')

	getEmojiWant((data, peerId) => {
		void handleFedEmojiWant(
			username,
			groupId,
			data,
			peerId,
			(payload, targetPeer) => {
				try { sendEmojiData(payload, targetPeer) }
				catch { /* ignore */ }
			},
			isBlockedPeer,
			peerToNode,
		).catch(() => {})
	})

	getEmojiData(data => {
		void handleFedEmojiData(username, groupId, data).catch(() => {})
	})

	/**
	 * @param {string} emojiId 表情 ID
	 * @returns {Promise<{ dataUrl: string, mimeType: string } | null>} P2P 拉取结果
	 */
	slot.requestGroupEmoji = function requestGroupEmoji(emojiId) {
		return requestGroupEmojiFromPeers(username, groupId, emojiId, slot)
	}

	/**
	 * @param {string} emojiId 表情 ID
	 * @returns {Promise<void>}
	 */
	slot.replicateGroupEmoji = function replicateGroupEmoji(emojiId) {
		return replicateGroupEmojiToFederation(username, groupId, emojiId, slot)
	}
}
