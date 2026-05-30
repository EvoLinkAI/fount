import { loadFollowing } from '../following.mjs'

import { syncTimelineForEntity } from './relay.mjs'

/**
 * 加载首页前同步关注账户的远程时间线（mailbox / 联邦）。
 * @param {string} username 用户
 * @param {object} [options] 选项
 * @param {number} [options.max=24] 最多同步多少个关注
 * @returns {Promise<{ attempted: number, ok: number }>} 同步统计
 */
export async function syncFollowingTimelines(username, options = {}) {
	const max = Math.min(Math.max(Number(options.max) || 24, 1), 64)
	const { following } = await loadFollowing(username)
	const targets = following.slice(0, max)
	const results = await Promise.allSettled(
		targets.map(entityHash => syncTimelineForEntity(username, entityHash)),
	)
	return {
		attempted: targets.length,
		ok: results.filter(result => result.status === 'fulfilled').length,
	}
}
