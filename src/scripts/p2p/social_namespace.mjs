/**
 * Social 时间线 / vault 命名空间（复用 DAG groupId 字段）。
 */
const ENTITY_HASH_RE = /^[\da-f]{128}$/u

/**
 * @param {string} entityHash 128 hex
 * @returns {string} DAG groupId
 */
export function timelineGroupId(entityHash) {
	const id = String(entityHash || '').trim().toLowerCase()
	if (!ENTITY_HASH_RE.test(id)) throw new Error('invalid entityHash')
	return `social-timeline:${id}`
}

/**
 * @param {string} entityHash 128 hex
 * @returns {string} vault 逻辑库 groupId
 */
export function vaultGroupId(entityHash) {
	const id = String(entityHash || '').trim().toLowerCase()
	if (!ENTITY_HASH_RE.test(id)) throw new Error('invalid entityHash')
	return `social-vault:${id}`
}

/** @type {Set<string>} */
export const SOCIAL_TIMELINE_EVENT_TYPES = new Set([
	'social_meta',
	'post',
	'post_delete',
	'repost',
	'like',
	'unlike',
	'follow',
	'unfollow',
	'file_share',
	'follow_approve',
])

/** @type {Set<string>} */
export const SOCIAL_RPC_TYPES = new Set([
	'social_discover_request',
	'social_discover_response',
	'social_post_discover_request',
	'social_post_discover_response',
	'social_follow_graph_request',
	'social_follow_graph_response',
	'social_on_mention',
	'social_on_mention_response',
	'social_timeline_pull_request',
	'social_timeline_pull_response',
])
