/**
 * 入群快照 Trystero 载荷解析（无 DAG 依赖）。
 */
import { isPlainObject } from '../lib/wireIngress.mjs'

/**
 * 将未知输入安全地读取为去空白字符串。
 * @param {unknown} value 输入值
 * @returns {string} 去空白后的字符串（非字符串返回空串）
 */
function readTrimmedString(value) {
	return typeof value === 'string' ? value.trim() : ''
}

/**
 * 将未知输入读取为可选的小写字符串。
 * @param {unknown} value 输入值
 * @returns {string | undefined} 小写字符串；空串/非字符串返回 undefined
 */
function readOptionalLowerString(value) {
	const s = readTrimmedString(value)
	return s ? s.toLowerCase() : undefined
}

/**
 * @param {unknown} data 载荷
 * @returns {object | null} 解析后的请求或 null
 */
export function parseJoinSnapshotRequest(data) {
	if (!isPlainObject(data)) return null
	const requestId = readTrimmedString(data.requestId)
	const requesterId = readTrimmedString(data.requesterId)
	const groupId = readTrimmedString(data.groupId)
	if (!requestId || !requesterId || !groupId) return null
	return {
		requestId,
		requesterId,
		groupId,
		tipsHash: readOptionalLowerString(data.tipsHash),
	}
}

/**
 * @param {unknown} data 载荷
 * @returns {object | null} 解析后的响应或 null
 */
export function parseJoinSnapshotResponse(data) {
	if (!isPlainObject(data)) return null
	const requestId = readTrimmedString(data.requestId)
	const requesterId = readTrimmedString(data.requesterId)
	const responderNodeId = readTrimmedString(data.responderNodeId)
	if (!requestId || !requesterId || !responderNodeId) return null
	if (!isPlainObject(data.checkpoint) && !isPlainObject(data.channelHistories)) return null
	return {
		requestId,
		requesterId,
		responderNodeId,
		checkpoint: data.checkpoint,
		channelHistories: data.channelHistories,
	}
}
