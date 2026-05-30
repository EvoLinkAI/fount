import { publishTimelineEvent } from '../federation/relay.mjs'

/**
 * 本地 append 后 fanout 到联邦邻居。
 * @param {string} username 用户
 * @param {string} entityHash 时间线 owner
 * @param {object} signedEvent 签名事件
 * @returns {Promise<void>}
 */
export async function fanoutTimelineEvent(username, entityHash, signedEvent) {
	await publishTimelineEvent(username, entityHash, signedEvent)
}
