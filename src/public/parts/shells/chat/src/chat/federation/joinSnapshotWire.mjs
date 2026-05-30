/**
 * 入群快照 / 补拉 Trystero 载荷解析（Breaking：必含 attestation / envelope）。
 */
import { isPlainObject } from '../lib/wireIngress.mjs'

import { parsePullAttestation, parsePullResponseEnvelope } from './fedPullWire.mjs'

/**
 * @param {unknown} value 输入
 * @returns {string} 去空白字符串
 */
function readTrimmedString(value) {
	return typeof value === 'string' ? value.trim() : ''
}

/**
 * @param {unknown} value 输入
 * @returns {string | undefined} 小写字符串
 */
function readOptionalLowerString(value) {
	const trimmedString = readTrimmedString(value)
	return trimmedString ? trimmedString.toLowerCase() : undefined
}

/**
 * @param {unknown} data 载荷
 * @returns {object | null} 解析后的请求或 null
 */
export function parseJoinSnapshotRequest(data) {
	if (!isPlainObject(data)) return null
	const requestId = readTrimmedString(data.requestId)
	const requesterNodeId = readTrimmedString(data.requesterNodeId)
	const groupId = readTrimmedString(data.groupId)
	const attestation = parsePullAttestation(data.attestation)
	if (!requestId || !requesterNodeId || !groupId || !attestation) return null
	if (attestation.groupId !== groupId || attestation.requestId !== requestId) return null
	return {
		requestId,
		requesterNodeId,
		requesterPubKeyHash: attestation.requesterPubKeyHash,
		groupId,
		tipsHash: readOptionalLowerString(data.tipsHash),
		attestation,
	}
}

/**
 * @param {unknown} data 载荷
 * @returns {object | null} 解析后的 envelope 或 null
 */
export function parseJoinSnapshotResponse(data) {
	return parsePullResponseEnvelope(data)
}
