import { appendTimelineEvent } from './timeline/append.mjs'
import { getTimelineMaterialized } from './timeline/materialize.mjs'
import { fanoutTimelineEvent } from './timeline/publish.mjs'

/**
 * 追加 social_meta 事件更新探索资料。
 * @param {string} username replica 登录名
 * @param {string} entityHash 时间线 owner
 * @param {object} patch 可写字段
 * @param {string} [patch.exploreBlurb] 探索页简介
 * @param {boolean} [patch.isProtected] 是否从探索隐藏
 * @returns {Promise<object>} 物化后的 socialMeta
 */
export async function updateSocialMeta(username, entityHash, patch) {
	/** @type {Record<string, unknown>} */
	const content = {}
	if (patch.exploreBlurb !== undefined) content.exploreBlurb = patch.exploreBlurb
	if (patch.isProtected !== undefined) content.isProtected = patch.isProtected
	if (!Object.keys(content).length)
		return (await getTimelineMaterialized(username, entityHash)).socialMeta

	const event = await appendTimelineEvent(username, entityHash, {
		type: 'social_meta',
		content,
	})
	await fanoutTimelineEvent(username, entityHash, event)
	return (await getTimelineMaterialized(username, entityHash)).socialMeta
}
