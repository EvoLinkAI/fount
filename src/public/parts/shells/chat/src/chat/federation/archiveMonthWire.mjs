/**
 * 冷归档按月联邦 wire 解析（无 DAG/peerPool 依赖，供单元测试 import）。
 */
import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { isPlainObject } from '../../../../../../../scripts/p2p/wire_ingress.mjs'
import { parseArchiveMonthWireParts } from '../archive/monthChunks.mjs'

/**
 * @param {unknown} payload wire 载荷
 * @returns {object | null} 解析后的 want
 */
export function parseFedArchiveMonthWant(payload) {
	if (!isPlainObject(payload)) return null
	const groupId = String(payload.groupId || '').trim()
	const channelId = String(payload.channelId || '').trim()
	const utcMonth = String(payload.utcMonth || '').trim()
	const requestId = String(payload.requestId || '').trim()
	const attestation = isPlainObject(payload.attestation) ? payload.attestation : null
	if (!groupId || !channelId || !/^\d{4}-\d{2}$/u.test(utcMonth) || !requestId || !attestation)
		return null
	return {
		groupId,
		channelId,
		utcMonth,
		requestId,
		requesterNodeHash: String(payload.requesterNodeHash || '').trim(),
		attestation,
	}
}

/**
 * @param {unknown} payload wire 载荷
 * @returns {object | null} 解析后的 response
 */
export function parseFedArchiveMonthResponse(payload) {
	if (!isPlainObject(payload)) return null
	const requestId = String(payload.requestId || '').trim()
	const channelId = String(payload.channelId || '').trim()
	const utcMonth = String(payload.utcMonth || '').trim()
	if (!requestId || !channelId || !/^\d{4}-\d{2}$/u.test(utcMonth)) return null
	if (typeof payload.body === 'string' && payload.body.length) return null
	const complete = payload.complete !== false
	const digest = String(payload.digest || '').trim().toLowerCase()
	const parts = complete
		? parseArchiveMonthWireParts(payload.parts) ?? null
		: []
	if (complete && (!isHex64(digest) || parts === null)) return null
	return {
		requestId,
		channelId,
		utcMonth,
		digest: complete ? digest : '',
		parts: complete ? parts : [],
		seal: isPlainObject(payload.seal) ? payload.seal : null,
		complete,
		reason: String(payload.reason || '').trim(),
	}
}
