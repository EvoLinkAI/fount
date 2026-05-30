/**
 * Mailbox 联邦线消息解析（入站）。
 */
import { normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { isPlainObject } from '../lib/wireIngress.mjs'

/**
 * @param {unknown} payload 载荷
 * @returns {object | null} 解析结果
 */
export function parseMailboxPut(payload) {
	if (!isPlainObject(payload) || !payload.record) return null
	return payload
}

/**
 * @param {unknown} payload 载荷
 * @returns {object | null} 解析结果
 */
export function parseMailboxWant(payload) {
	if (!isPlainObject(payload)) return null
	if (!normalizeHex64(payload.toPubKeyHash)) return null
	return payload
}

/**
 * @param {unknown} payload 载荷
 * @returns {object | null} 解析结果
 */
export function parseMailboxGive(payload) {
	if (!isPlainObject(payload) || !Array.isArray(payload.records)) return null
	return payload
}
