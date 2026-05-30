/**
 * 群发现联邦线消息解析（入站）。
 */
import { isPlainObject } from '../lib/wireIngress.mjs'

/**
 * @param {unknown} payload 载荷
 * @returns {{ nodeId: string, advertisements: object[] } | null} 解析结果
 */
export function parseDiscoveryAnnounce(payload) {
	if (!isPlainObject(payload)) return null
	const nodeId = String(payload.nodeId || '').trim()
	if (!nodeId) return null
	return {
		nodeId,
		advertisements: Array.isArray(payload.advertisements) ? payload.advertisements : [],
	}
}

/**
 * @param {unknown} payload 载荷
 * @returns {{ nodeId: string, requestId: string, limit: number } | null} 解析结果
 */
export function parseDiscoveryQuery(payload) {
	if (!isPlainObject(payload)) return null
	const nodeId = String(payload.nodeId || '').trim()
	const requestId = String(payload.requestId || '').trim()
	if (!nodeId || !requestId) return null
	return {
		nodeId,
		requestId,
		limit: Math.min(64, Math.max(1, Number(payload.limit) || 32)),
	}
}

/**
 * @param {unknown} payload 载荷
 * @returns {{ requestId: string, nodeId: string, advertisements: object[] } | null} 解析结果
 */
export function parseDiscoveryQueryResponse(payload) {
	if (!isPlainObject(payload)) return null
	const requestId = String(payload.requestId || '').trim()
	const nodeId = String(payload.nodeId || '').trim()
	if (!requestId || !nodeId) return null
	return {
		requestId,
		nodeId,
		advertisements: Array.isArray(payload.advertisements) ? payload.advertisements : [],
	}
}
