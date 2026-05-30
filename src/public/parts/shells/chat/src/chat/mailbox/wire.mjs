/**
 * Mailbox 联邦线消息解析（入站）。
 */
import { assertHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import {
	assertMailboxPubKeyHash,
	assertMailboxRecordShape,
} from '../../../../../../../scripts/p2p/schemas/mailbox_wire.mjs'
import { isPlainObject } from '../lib/wireIngress.mjs'

/**
 * @param {unknown} payload 载荷
 * @returns {object | null} 解析结果
 */
export function parseMailboxPut(payload) {
	if (!isPlainObject(payload) || !isPlainObject(payload.record)) return null
	try {
		assertMailboxRecordShape(payload.record)
		if (payload.nodeId != null)
			assertHex64(payload.nodeId, 'mailbox_put.nodeId')
		return payload
	}
	catch {
		return null
	}
}

/**
 * @param {unknown} payload 载荷
 * @returns {object | null} 解析结果
 */
export function parseMailboxWant(payload) {
	if (!isPlainObject(payload)) return null
	try {
		return {
			...payload,
			toPubKeyHash: assertMailboxPubKeyHash(payload.toPubKeyHash),
		}
	}
	catch {
		return null
	}
}

/**
 * @param {unknown} payload 载荷
 * @returns {object | null} 解析结果
 */
export function parseMailboxGive(payload) {
	if (!isPlainObject(payload) || !Array.isArray(payload.records)) return null
	return payload
}
