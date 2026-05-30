/**
 * Social 时间线事件入库 canonicalize。
 */
import { assertHex64 } from '../../../../../../scripts/p2p/hexIds.mjs'
import { validateRemoteEventShape } from '../../../../../../scripts/p2p/schemas/remote_event.mjs'

/** @type {Set<string>} */
const HEX_CONTENT_KEYS = new Set([
	'targetPostId',
	'targetEntityHash',
	'targetId',
])

/**
 * 规范化时间线事件 content 中的 hex 字段。
 * @param {object} content 事件 content
 * @returns {object | undefined} 规范化后的 content；非对象则原样返回
 */
function canonicalizeTimelineContent(content) {
	if (!content || typeof content !== 'object') return content
	const out = { ...content }
	for (const key of HEX_CONTENT_KEYS)
		if (key in out && out[key] != null && out[key] !== '')
			out[key] = assertHex64(out[key], key)

	if (out.targetEntityHash)
		out.targetEntityHash = String(out.targetEntityHash).toLowerCase()
	return out
}

/**
 * 对签名时间线事件做入库 canonicalize。
 * @param {object} event 签名时间线事件
 * @returns {object} canonical 行
 */
export function canonicalizeSignedTimelineEvent(event) {
	validateRemoteEventShape(event)
	const out = { ...event }
	out.id = assertHex64(out.id, 'id')
	out.sender = assertHex64(out.sender, 'sender')
	if (Array.isArray(out.prev_event_ids))
		out.prev_event_ids = out.prev_event_ids.map((id, index) =>
			assertHex64(id, `prev_event_ids[${index}]`),
		)
	if (out.content)
		out.content = canonicalizeTimelineContent(out.content)
	return out
}
