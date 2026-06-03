/**
 * 联邦补拉 attestation / HPKE 响应 wire 解析（Breaking：无 attestation/envelope 即丢弃）。
 */
import { isHex64, normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { isPlainObject } from '../../../../../../../scripts/p2p/wire_ingress.mjs'

import { EVENT_ID_HEX } from './registry.mjs'

/** @typedef {{ requesterPubKeyHash: string, groupId: string, requestId: string, timestamp: number, wantIds?: string[], signature: string }} PullAttestation */

/**
 * @param {unknown} value 输入
 * @returns {string} 去空白字符串
 */
function readTrimmed(value) {
	return String(value ?? '').trim()
}

/**
 * @param {unknown} attestation 载荷 attestation 字段
 * @returns {PullAttestation | null} 解析结果
 */
export function parsePullAttestation(attestation) {
	if (!isPlainObject(attestation)) return null
	const requesterPubKeyHash = normalizeHex64(attestation.requesterPubKeyHash)
	const groupId = readTrimmed(attestation.groupId)
	const requestId = readTrimmed(attestation.requestId)
	const timestamp = Number(attestation.timestamp)
	const signature = readTrimmed(attestation.signature)
	if (!isHex64(requesterPubKeyHash) || !groupId || !Number.isFinite(timestamp) || !signature)
		return null
	const wantIds = Array.isArray(attestation.wantIds)
		? [...new Set(attestation.wantIds.map(id => String(id).trim().toLowerCase()).filter(id => EVENT_ID_HEX.test(id)))]
		: undefined
	return {
		requesterPubKeyHash,
		groupId,
		requestId,
		timestamp,
		wantIds,
		signature,
	}
}

/**
 * @param {unknown} envelope 响应 envelope
 * @returns {{ requestId: string, requesterPubKeyHash: string, requesterNodeHash: string, ephemPub: string, iv: string, ciphertext: string, authTag: string } | null} 解析后的 envelope；缺字段为 null
 */
export function parsePullResponseEnvelope(envelope) {
	if (!isPlainObject(envelope)) return null
	const requestId = readTrimmed(envelope.requestId)
	const requesterPubKeyHash = normalizeHex64(envelope.requesterPubKeyHash)
	const requesterNodeHash = readTrimmed(envelope.requesterNodeHash)
	const ephemPub = readTrimmed(envelope.ephemPub)
	const iv = readTrimmed(envelope.iv)
	const ciphertext = readTrimmed(envelope.ciphertext)
	const authTag = readTrimmed(envelope.authTag)
	if (!requestId || !isHex64(requesterPubKeyHash) || !requesterNodeHash) return null
	if (!ephemPub || !iv || !ciphertext || !authTag) return null
	return {
		requestId,
		requesterPubKeyHash,
		requesterNodeHash,
		ephemPub,
		iv,
		ciphertext,
		authTag,
	}
}

/**
 * @param {unknown} data 入群快照请求载荷
 * @returns {object | null} 解析后的请求或 null
 */
export function parseJoinSnapshotRequest(data) {
	if (!isPlainObject(data)) return null
	const requestId = readTrimmed(data.requestId)
	const requesterNodeHash = readTrimmed(data.requesterNodeHash)
	const groupId = readTrimmed(data.groupId)
	const attestation = parsePullAttestation(data.attestation)
	if (!requestId || !requesterNodeHash || !groupId || !attestation) return null
	if (attestation.groupId !== groupId || attestation.requestId !== requestId) return null
	const tipsHash = readTrimmed(data.tipsHash)
	return {
		requestId,
		requesterNodeHash,
		requesterPubKeyHash: attestation.requesterPubKeyHash,
		groupId,
		tipsHash: tipsHash ? tipsHash.toLowerCase() : undefined,
		attestation,
	}
}

/**
 * @param {unknown} data 入群快照响应载荷
 * @returns {object | null} 解析后的 envelope 或 null
 */
export function parseJoinSnapshotResponse(data) {
	return parsePullResponseEnvelope(data)
}
