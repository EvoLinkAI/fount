import { readFile } from 'node:fs/promises'

import { ensureLocalEntityProfile, getProfile } from '../../../../../scripts/p2p/entity/profile.mjs'
import { isEntityHash128 } from '../../../../../scripts/p2p/entity_id.mjs'
import { getUserDictionary } from '../../../../../server/auth.mjs'

import { isBlocked } from './blocklist.mjs'
import {
	buildEngagementIndex,
	buildViewerLikedSet,
	canViewPost,
	listKnownTimelineOwners,
	loadViewerContext,
} from './feedHelpers.mjs'
import { compareFeedItems } from './feedMerge.mjs'
import { loadFollowing } from './following.mjs'
import { maybeDecryptPostContent } from './gsh/vault.mjs'
import { createAuthorProfileLoader } from './lib/authorProfileSummary.mjs'
import { getTimelineMaterialized } from './timeline/materialize.mjs'

/**
 * 判断本地是否持有可读时间线 events.jsonl。
 * @param {string} username 用户
 * @param {string} entityHash 时间线 owner
 * @returns {Promise<boolean>} 本地是否持有可读时间线
 */
async function timelineExists(username, entityHash) {
	try {
		await readFile(`${getUserDictionary(username)}/shells/social/timelines/${entityHash}/events.jsonl`, 'utf8')
		return true
	}
	catch {
		return false
	}
}

/**
 * 解析并校验对观看者可见的帖子。
 * @param {string} username 用户
 * @param {string} entityHash 作者
 * @param {string} postId 帖子 id
 * @param {object} viewerContext 观看者上下文
 * @returns {Promise<object | null>} 可见帖子或 null
 */
async function resolveVisiblePost(username, entityHash, postId, viewerContext) {
	if (!await timelineExists(username, entityHash)) return null
	const view = await getTimelineMaterialized(username, entityHash)
	const post = view.postById?.[postId]
	if (!post) return null
	const enriched = { ...post, entityHash, senderEntityHash: entityHash }
	if (!canViewPost(enriched, viewerContext.viewerEntityHash, viewerContext.blocked, viewerContext.following))
		return null
	return post
}

/**
 * 构建关注流首页 feed（含原帖与转发，多路归并排序）。
 * @param {string} username 用户
 * @param {object} [options] 分页选项
 * @param {number} [options.limit=50] 条数上限
 * @param {string} [options.cursor] 分页游标
 * @returns {Promise<{ items: object[], nextCursor: string | null }>} 首页 feed
 */
export async function buildHomeFeed(username, options = {}) {
	const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200)
	const { following } = await loadFollowing(username)
	const viewerContext = await loadViewerContext(username)
	/** @type {Set<string>} */
	const feedSources = new Set(following)
	if (viewerContext.viewerEntityHash)
		feedSources.add(viewerContext.viewerEntityHash.toLowerCase())

	const engagement = await buildEngagementIndex(username, feedSources)
	const viewerLiked = await buildViewerLikedSet(username)
	const authorProfile = createAuthorProfileLoader(username)

	/**
	 * 查询指定帖子的互动计数与观看者点赞状态。
	 * @param {string} targetEntityHash 原帖作者
	 * @param {string} targetPostId 原帖 id
	 * @returns {object} 互动计数与点赞状态
	 */
	function engagementForPost(targetEntityHash, targetPostId) {
		const key = `${targetEntityHash.toLowerCase()}:${targetPostId}`
		return {
			likeCount: engagement.likes.get(key) || 0,
			repostCount: engagement.reposts.get(key) || 0,
			replyCount: engagement.replies.get(key) || 0,
			viewerLiked: viewerLiked.has(key),
			targetEntityHash: targetEntityHash.toLowerCase(),
			targetPostId,
		}
	}

	/** @type {{ candidates: object[], index: number }[]} */
	const streams = []
	for (const entityHash of feedSources) {
		if (!isEntityHash128(entityHash)) continue
		if (await isBlocked(username, entityHash)) continue
		if (!await timelineExists(username, entityHash)) continue
		const view = await getTimelineMaterialized(username, entityHash)
		/** @type {object[]} */
		const candidates = []
		for (const post of view.posts) {
			const enriched = { ...post, entityHash, senderEntityHash: entityHash }
			if (!canViewPost(enriched, viewerContext.viewerEntityHash, viewerContext.blocked, viewerContext.following))
				continue
			candidates.push({
				kind: 'post',
				entityHash,
				postId: post.id,
				post,
				hlc: post.hlc,
			})
		}
		for (const repost of view.reposts) {
			const originalEntityHash = String(repost.content?.targetEntityHash || '').toLowerCase()
			const originalPostId = String(repost.content?.targetPostId || '')
			if (!isEntityHash128(originalEntityHash) || !originalPostId) continue
			candidates.push({
				kind: 'repost',
				entityHash,
				postId: repost.id,
				hlc: repost.hlc,
				repost,
				originalEntityHash,
				originalPostId,
			})
		}
		candidates.sort(compareFeedItems)
		streams.push({ candidates, index: 0 })
	}

	let collecting = !options.cursor
	/** @type {object[]} */
	const items = []
	let hasMore = false

	while (collecting ? items.length < limit : true) {
		let best = -1
		for (let index = 0; index < streams.length; index++) {
			const stream = streams[index]
			if (stream.index >= stream.candidates.length) continue
			const head = stream.candidates[stream.index]
			if (best < 0 || compareFeedItems(head, streams[best].candidates[streams[best].index]) > 0)
				best = index
		}
		if (best < 0) break

		const stream = streams[best]
		const head = stream.candidates[stream.index]
		stream.index++

		/** @type {object | null} */
		let item = null
		if (head.kind === 'repost') {
			const originalPost = await resolveVisiblePost(username, head.originalEntityHash, head.originalPostId, viewerContext)
			if (originalPost)
				item = {
					kind: 'repost',
					entityHash: head.entityHash,
					postId: head.postId,
					post: originalPost,
					repostComment: String(head.repost.content?.comment || ''),
					hlc: head.hlc,
					authorProfile: await authorProfile(head.entityHash),
					...engagementForPost(head.originalEntityHash, head.originalPostId),
				}

		}
		else
			item = {
				kind: 'post',
				entityHash: head.entityHash,
				postId: head.postId,
				post: head.post,
				hlc: head.hlc,
				authorProfile: await authorProfile(head.entityHash),
				...engagementForPost(head.entityHash, head.postId),
			}


		if (!item) continue
		const key = `${item.entityHash}:${item.postId}`
		if (!collecting) {
			if (key === options.cursor) collecting = true
			continue
		}
		items.push(item)
	}

	if (items.length === limit) {
		let peekBest = -1
		for (let index = 0; index < streams.length; index++) {
			const stream = streams[index]
			if (stream.index >= stream.candidates.length) continue
			const head = stream.candidates[stream.index]
			if (peekBest < 0 || compareFeedItems(head, streams[peekBest].candidates[streams[peekBest].index]) > 0)
				peekBest = index
		}
		hasMore = peekBest >= 0
	}

	const next = hasMore && items.length
		? `${items[items.length - 1].entityHash}:${items[items.length - 1].postId}`
		: null
	return { items, nextCursor: next }
}

/**
 * 构建资料页帖子列表（与首页 feed 同构）。
 * @param {string} username 用户
 * @param {string} entityHash 资料页 owner
 * @returns {Promise<{ entityHash: string, items: object[] }>} 与首页 feed 同构的帖子列表
 */
export async function buildProfileFeedItems(username, entityHash) {
	entityHash = String(entityHash || '').toLowerCase()
	if (!isEntityHash128(entityHash))
		return { entityHash, items: [] }

	const viewerContext = await loadViewerContext(username)
	const engagement = await buildEngagementIndex(username)
	const viewerLiked = await buildViewerLikedSet(username)

	/**
	 * 加载作者资料摘要（displayName、avatarUrl）。
	 * @param {string} hash 作者
	 * @returns {Promise<object | null>} 资料摘要
	 */
	async function authorProfile(hash) {
		const profile = await getEntityProfile(username, hash)
		return profile
			? { displayName: profile.displayName || profile.name, avatarUrl: profile.avatarUrl || null }
			: null
	}

	/**
	 * 查询指定帖子的互动计数与观看者点赞状态。
	 * @param {string} targetEntityHash 原帖作者
	 * @param {string} targetPostId 原帖 id
	 * @returns {object} 互动计数与点赞状态
	 */
	function engagementForPost(targetEntityHash, targetPostId) {
		const key = `${targetEntityHash.toLowerCase()}:${targetPostId}`
		return {
			likeCount: engagement.likes.get(key) || 0,
			repostCount: engagement.reposts.get(key) || 0,
			replyCount: engagement.replies.get(key) || 0,
			viewerLiked: viewerLiked.has(key),
			targetEntityHash: targetEntityHash.toLowerCase(),
			targetPostId,
		}
	}

	/**
	 * 解密帖子 content 并返回副本（失败时标记受保护）。
	 * @param {object} post 物化帖子
	 * @returns {Promise<object>} 解密后的帖子副本
	 */
	async function withDecryptedContent(post) {
		const decrypted = await maybeDecryptPostContent(username, entityHash, post.content)
		return { ...post, content: decrypted ?? { protected: true } }
	}

	if (!await timelineExists(username, entityHash))
		return { entityHash, items: [] }

	const view = await getTimelineMaterialized(username, entityHash)
	const author = await authorProfile(entityHash)
	/** @type {object[]} */
	const items = []

	for (const post of view.posts) {
		const enriched = { ...post, entityHash, senderEntityHash: entityHash }
		if (!canViewPost(enriched, viewerContext.viewerEntityHash, viewerContext.blocked, viewerContext.following))
			continue
		items.push({
			kind: 'post',
			entityHash,
			postId: post.id,
			post: await withDecryptedContent(post),
			hlc: post.hlc,
			authorProfile: author,
			...engagementForPost(entityHash, post.id),
		})
	}

	items.sort((left, right) => {
		const lw = Number(left.hlc?.wall) || 0
		const rw = Number(right.hlc?.wall) || 0
		if (lw !== rw) return rw - lw
		return String(right.postId).localeCompare(String(left.postId))
	})

	return { entityHash, items }
}

/**
 * 列出指定帖子的可见回复。
 * @param {string} username 用户
 * @param {string} entityHash 作者
 * @param {string} postId 帖子
 * @returns {Promise<object[]>} 可见回复
 */
export async function listReplies(username, entityHash, postId) {
	const viewerContext = await loadViewerContext(username)
	/** @type {object[]} */
	const replies = []

	for (const author of await listKnownTimelineOwners(username)) {
		if (viewerContext.blocked.has(author)) continue
		if (!await timelineExists(username, author)) continue
		const view = await getTimelineMaterialized(username, author)
		for (const post of view.posts) {
			const replyTo = post.content?.replyTo
			if (!replyTo) continue
			if (String(replyTo.entityHash).toLowerCase() !== entityHash.toLowerCase()) continue
			if (String(replyTo.postId) !== postId) continue
			if (!canViewPost({ ...post, entityHash: author, senderEntityHash: author }, viewerContext.viewerEntityHash, viewerContext.blocked, viewerContext.following))
				continue
			replies.push({ entityHash: author, post })
		}
	}

	replies.sort((left, right) => {
		const lw = Number(left.post.hlc?.wall) || 0
		const rw = Number(right.post.hlc?.wall) || 0
		return rw - lw
	})
	return replies
}

/**
 * 获取 entity 的 Chat profile（必要时自动创建本地资料）。
 * @param {string} username 用户
 * @param {string} entityHash 目标
 * @returns {Promise<object | null>} chat entities profile
 */
export async function getEntityProfile(username, entityHash) {
	if (!isEntityHash128(entityHash)) return null
	await ensureLocalEntityProfile(username, entityHash)
	return getProfile(entityHash, username)
}
