import { resolveOperatorEntityHash } from '../../../../../scripts/p2p/entity/replica.mjs'

import { loadSocialBlocklist } from './blocklist.mjs'
import { loadFollowing } from './following.mjs'
import { getTimelineMaterialized } from './timeline/materialize.mjs'

/**
 * 列出观看者已知的时间线 owner（关注 + 自身）。
 * @param {string} username 用户
 * @returns {Promise<string[]>} 已知时间线 owner（关注 + 自身）
 */
export async function listKnownTimelineOwners(username) {
	const { following } = await loadFollowing(username)
	const self = resolveOperatorEntityHash(username)
	const set = new Set(following)
	if (self) set.add(self.toLowerCase())
	return [...set]
}

/**
 * 根据可见性与拉黑/关注关系判断帖子是否对观看者可见。
 * @param {object} post 帖子
 * @param {string | null} viewerEntityHash 观看者 entityHash
 * @param {Set<string>} blocked 拉黑集合
 * @param {Set<string>} following 观看者关注列表
 * @returns {boolean} 是否可见
 */
export function canViewPost(post, viewerEntityHash, blocked, following) {
	const authorEntity = String(post.senderEntityHash || post.entityHash || '').toLowerCase()
	if (blocked.has(authorEntity)) return false
	if (viewerEntityHash && authorEntity === viewerEntityHash.toLowerCase()) return true
	const visibility = post.content?.visibility || 'public'
	if (visibility === 'public') return true
	if (visibility === 'followers') return following.has(authorEntity)
	return false
}

/**
 * 扫描时间线构建点赞/转发/回复计数索引。
 * @param {string} username 用户
 * @param {Iterable<string>} [owners] 仅扫描这些时间线 owner；缺省为全部已知 owner
 * @returns {Promise<{ likes: Map<string, number>, reposts: Map<string, number>, replies: Map<string, number> }>} 各帖子键的点赞/转发/回复计数
 */
export async function buildEngagementIndex(username, owners = null) {
	/** @type {Map<string, number>} */
	const likes = new Map()
	/** @type {Map<string, number>} */
	const reposts = new Map()
	/** @type {Map<string, number>} */
	const replies = new Map()

	const ownerList = owners ? [...owners] : await listKnownTimelineOwners(username)
	for (const owner of ownerList) {
		const view = await getTimelineMaterialized(username, owner)
		for (const like of view.likes) {
			const key = `${String(like.content?.targetEntityHash || '').toLowerCase()}:${like.content?.targetPostId}`
			if (!key.includes(':')) continue
			likes.set(key, (likes.get(key) || 0) + 1)
		}
		for (const repost of view.reposts) {
			const key = `${String(repost.content?.targetEntityHash || '').toLowerCase()}:${repost.content?.targetPostId}`
			if (!key.includes(':')) continue
			reposts.set(key, (reposts.get(key) || 0) + 1)
		}
		for (const post of view.posts) {
			const replyTo = post.content?.replyTo
			if (!replyTo?.entityHash || !replyTo?.postId) continue
			const key = `${String(replyTo.entityHash).toLowerCase()}:${replyTo.postId}`
			replies.set(key, (replies.get(key) || 0) + 1)
		}
	}
	return { likes, reposts, replies }
}

/**
 * 收集观看者已点赞的帖子键集合。
 * @param {string} username 用户
 * @returns {Promise<Set<string>>} 观看者已点赞的 `entityHash:postId` 键集合
 */
export async function buildViewerLikedSet(username) {
	const self = resolveOperatorEntityHash(username)
	if (!self) return new Set()
	const view = await getTimelineMaterialized(username, self)
	/** @type {Set<string>} */
	const liked = new Set()
	for (const like of view.likes) {
		const key = `${String(like.content?.targetEntityHash || '').toLowerCase()}:${like.content?.targetPostId}`
		if (key.includes(':')) liked.add(key)
	}
	return liked
}

/**
 * 加载观看者上下文（拉黑、关注、自身 entityHash）。
 * @param {string} username 用户
 * @returns {Promise<{ blocked: Set<string>, following: Set<string>, viewerEntityHash: string | null }>} 观看者上下文
 */
export async function loadViewerContext(username) {
	const { following } = await loadFollowing(username)
	const { blocked: blockedList } = await loadSocialBlocklist(username)
	return {
		blocked: new Set(blockedList),
		following: new Set(following),
		viewerEntityHash: resolveOperatorEntityHash(username),
	}
}
