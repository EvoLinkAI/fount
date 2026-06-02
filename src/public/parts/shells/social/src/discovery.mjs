import { readdir } from 'node:fs/promises'

import { ensureLocalEntityProfile, getProfile } from '../../../../../scripts/p2p/entity/profile.mjs'
import { isEntityHash128 } from '../../../../../scripts/p2p/entity_id.mjs'
import { getUserDictionary } from '../../../../../server/auth.mjs'

import { getTimelineMaterialized } from './timeline/materialize.mjs'

/**
 * 列出本机已知的时间线 owner entityHash。
 * @param {string} username 用户
 * @returns {Promise<string[]>} 本地已知时间线 entityHash
 */
export async function listLocalTimelineOwners(username) {
	const root = `${getUserDictionary(username)}/shells/social/timelines`
	try {
		const entries = await readdir(root, { withFileTypes: true })
		return entries.filter(entry => entry.isDirectory())
			.map(entry => entry.name.toLowerCase())
			.filter(isEntityHash128)
	}
	catch {
		return []
	}
}

/**
 * 探索页推荐公开账户（跳过受保护时间线）。
 * @param {string} username 用户
 * @param {object} [options] 探索选项
 * @param {number} [options.n=20] 返回账户数
 * @returns {Promise<{ accounts: object[], nextCursor: string | null }>} 推荐账户
 */
export async function discoverAccounts(username, options = {}) {
	const accountLimit = Math.min(Math.max(Number(options.n) || 20, 1), 100)
	const owners = await listLocalTimelineOwners(username)
	/** @type {object[]} */
	const accounts = []
	for (const entityHash of owners.slice(0, accountLimit)) {
		const view = await getTimelineMaterialized(username, entityHash)
		if (view.socialMeta?.isProtected) continue
		let profile = null
		try {
			await ensureLocalEntityProfile(username, entityHash)
			profile = await getProfile(entityHash, username)
		}
		catch {
			// 本地时间线可能包含远端 owner；探索页应降级跳过而非 500
			continue
		}
		accounts.push({
			entityHash,
			name: profile?.displayName || profile?.name || entityHash.slice(0, 8),
			exploreBlurb: view.socialMeta?.exploreBlurb || profile?.bio || '',
			avatarUrl: profile?.avatarUrl || null,
		})
	}
	return { accounts, nextCursor: owners.length > accountLimit ? owners[accountLimit] : null }
}

/**
 * 从本地可见时间线随机采样公开帖子。
 * @param {string} username 用户
 * @param {object} [options] 探索选项
 * @param {number} [options.n=20] 返回帖子数
 * @param {boolean} [options.mediaOnly=false] 仅含媒体
 * @returns {Promise<{ posts: object[], nextCursor: string | null }>} 随机帖子
 */
export async function discoverPosts(username, options = {}) {
	const postLimit = Math.min(Math.max(Number(options.n) || 20, 1), 100)
	const mediaOnly = Boolean(options.mediaOnly)
	const owners = await listLocalTimelineOwners(username)
	/** @type {object[]} */
	const posts = []

	for (const entityHash of owners) {
		const view = await getTimelineMaterialized(username, entityHash)
		if (view.socialMeta?.isProtected) continue
		for (const post of view.posts) {
			if (post.content?.visibility === 'followers') continue
			if (mediaOnly && !post.content?.mediaRefs?.length) continue
			posts.push({
				entityHash,
				postId: post.id,
				textSnippet: (post.content?.text || '').slice(0, 280),
				mediaThumbs: post.content?.mediaRefs.slice(0, 4) || [],
				hlc: post.hlc,
			})
		}
	}

	for (let index = posts.length - 1; index > 0; index--) {
		const randomIndex = Math.floor(Math.random() * (index + 1))
		;[posts[index], posts[randomIndex]] = [posts[randomIndex], posts[index]]
	}

	const sampledPosts = posts.slice(0, postLimit)
	return {
		posts: sampledPosts,
		nextCursor: posts.length > postLimit
			? `${sampledPosts[sampledPosts.length - 1]?.entityHash}:${sampledPosts[sampledPosts.length - 1]?.postId}`
			: null,
	}
}

/**
 * 读取指定 entity 的 following 列表（本地物化视图）。
 * @param {string} username 用户
 * @param {string} entityHash 目标
 * @returns {Promise<string[]>} 本地可见 following 列表
 */
export async function discoverFollowGraph(username, entityHash) {
	const view = await getTimelineMaterialized(username, entityHash)
	return view.following
}

/**
 * P2P RPC 处理器（供联邦层调用）。
 * @param {string} username 本地用户
 * @param {object} rpc RPC 体
 * @returns {Promise<object | null>} RPC 响应体
 */
export async function handleSocialRpc(username, rpc) {
	switch (rpc?.type) {
		case 'social_discover_request':
			return { type: 'social_discover_response', ...await discoverAccounts(username, rpc) }
		case 'social_post_discover_request':
			return { type: 'social_post_discover_response', ...await discoverPosts(username, rpc) }
		case 'social_follow_graph_request':
			return {
				type: 'social_follow_graph_response',
				entityHash: rpc.entityHash,
				following: await discoverFollowGraph(username, String(rpc.entityHash)),
			}
		case 'social_on_mention': {
			const { processSocialOnMentionRpc } = await import('./dispatch.mjs')
			return {
				type: 'social_on_mention_response',
				...await processSocialOnMentionRpc(username, rpc),
			}
		}
		default:
			return null
	}
}
