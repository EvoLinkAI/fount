/**
 * Chat 群 DAG 事件入库 canonicalize（形状规范化，非权限校验）。
 */
import { canonicalizeSignedRow } from '../../../../../../../scripts/p2p/dag/canonicalizeRow.mjs'
import { validateRemoteEventShape } from '../../../../../../../scripts/p2p/schemas/remote_event.mjs'
import { sanitizeFederatedEvent } from '../events/wire.mjs'

/** content / 顶层可选 hex64 字段名 */
const CHAT_CONTENT_HEX_KEYS = new Set([
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

const CHAT_ROW_OPTS = {
	prepare: sanitizeFederatedEvent,
	contentHexKeys: CHAT_CONTENT_HEX_KEYS,
}

/**
 * @param {object} event 签名事件
 * @returns {object} canonical 行
 */
export function canonicalizeSignedChatEvent(event) {
	return canonicalizeSignedRow(event, CHAT_ROW_OPTS)
}

/**
 * @param {object} event 远程入站事件
 * @returns {object} canonical 行
 */
export function prepareInboundRemoteChatEvent(event) {
	validateRemoteEventShape(event)
	return canonicalizeSignedChatEvent(event)
}
