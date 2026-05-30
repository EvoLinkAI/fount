/**
 * Chat 群 DAG 事件入库 canonicalize（形状规范化，非权限校验）。
 */
import { assertHex64, HEX_ID_64, normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { sanitizeFederatedEvent } from '../events/wire.mjs'

/** content / 顶层可选 hex64 字段名 */
const HEX64_FIELD_NAMES = new Set([
	'targetId',
	'targetPubKeyHash',
	'targetNodeHash',
	'targetEntityHash',
	'homeNodeHash',
	'introducerPubKeyHash',
	'delegatedOwnerPubKeyHash',
	'contentHash',
	'ciphertextHash',
	'from',
	'to',
	'charOwner',
])

/**
 * @param {Record<string, unknown>} obj 可变对象
 * @param {string} key 字段名
 */
function canonicalizeHexField(obj, key) {
	if (!(key in obj) || obj[key] == null || obj[key] === '') return
	const normalized = normalizeHex64(obj[key])
	if (!HEX_ID_64.test(normalized))
		throw new Error(`${key} must be 64 hex characters`)
	obj[key] = normalized
}

/**
 * @param {unknown} content 事件 content
 * @returns {object | undefined} 规范化后的 content
 */
function canonicalizeContent(content) {
	if (!content || typeof content !== 'object') return content
	const out = { ...content }
	for (const key of HEX64_FIELD_NAMES)
		canonicalizeHexField(out, key)
	if (out.content_ref && typeof out.content_ref === 'object') {
		const ref = { ...out.content_ref }
		canonicalizeHexField(ref, 'contentHash')
		out.content_ref = ref
	}
	return out
}

/**
 * 签名事件落盘前规范化（变异返回新对象）。
 * @param {object} signPayload 完整签名事件
 * @returns {object} canonical 行
 */
export function canonicalizeSignedChatEvent(signPayload) {
	const out = sanitizeFederatedEvent({ ...signPayload })
	out.id = assertHex64(out.id, 'id')
	out.sender = assertHex64(out.sender, 'sender')
	if (Array.isArray(out.prev_event_ids))
		out.prev_event_ids = out.prev_event_ids.map((id, index) =>
			assertHex64(id, `prev_event_ids[${index}]`),
		)
	if (out.senderHomeNodeHash)
		out.senderHomeNodeHash = assertHex64(out.senderHomeNodeHash, 'senderHomeNodeHash')
	if (out.content)
		out.content = canonicalizeContent(out.content)
	return out
}
