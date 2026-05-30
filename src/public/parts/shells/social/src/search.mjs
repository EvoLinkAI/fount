import { readFile } from 'node:fs/promises'

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
import { maybeDecryptPostContent } from './gsh/vault.mjs'
import { createAuthorProfileLoader } from './lib/authorProfileSummary.mjs'
import { postMatchesQuery } from './lib/postQuery.mjs'
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
 * 在已知时间线中搜索可见帖子（关注 + 自身）。
 * @param {string} username 用户
 * @param {object} [options] 选项
 * @param {string} options.q 查询（至少 2 字符）
 * @param {number} [options.limit=30] 结果上限
 * @returns {Promise<{ query: string, items: object[] }>} 搜索结果
 */
export async function searchPosts(username, options = {}) {
	const query = String(options.q || '').trim()
	const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 100)
	if (query.length < 2)
		return { query, items: [] }

	const viewerContext = await loadViewerContext(username)
	const engagement = await buildEngagementIndex(username)
	const viewerLiked = await buildViewerLikedSet(username)
	const authorProfile = createAuthorProfileLoader(username)

	/**
	 * 查询指定帖子的互动计数与观看者点赞状态。
	 * @param {string} targetEntityHash 原帖作者
	 * @param {string} targetPostId 原帖 id
	 * @returns {object} 互动计数
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

	/** @type {object[]} */
	const items = []
	for (const entityHash of await listKnownTimelineOwners(username)) {
		if (!isEntityHash128(entityHash)) continue
		if (await isBlocked(username, entityHash)) continue
		if (!await timelineExists(username, entityHash)) continue
		const view = await getTimelineMaterialized(username, entityHash)
		for (const post of view.posts) {
			if (!postMatchesQuery(post, query)) continue
			const enriched = { ...post, entityHash, senderEntityHash: entityHash }
			if (!canViewPost(enriched, viewerContext.viewerEntityHash, viewerContext.blocked, viewerContext.following))
				continue
			const decrypted = await maybeDecryptPostContent(username, entityHash, post.content)
			const postOut = { ...post, content: decrypted ?? post.content }
			if (!postMatchesQuery({ ...postOut, entityHash }, query)) continue
			items.push({
				kind: 'post',
				entityHash,
				postId: post.id,
				post: postOut,
				hlc: post.hlc,
				authorProfile: await authorProfile(entityHash),
				...engagementForPost(entityHash, post.id),
			})
		}
	}

	items.sort((left, right) => {
		const lw = Number(left.hlc?.wall) || 0
		const rw = Number(right.hlc?.wall) || 0
		if (lw !== rw) return rw - lw
		return String(right.postId).localeCompare(String(left.postId))
	})

	return { query, items: items.slice(0, limit) }
}
