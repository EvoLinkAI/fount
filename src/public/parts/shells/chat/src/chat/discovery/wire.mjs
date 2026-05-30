/**
 * 群发现联邦线消息解析（入站）。
 */
import {
	assertDiscoveryNodeId,
	assertDiscoveryRequestId,
} from '../../../../../../../scripts/p2p/schemas/discovery_wire.mjs'
import { isPlainObject } from '../lib/wireIngress.mjs'

/**
 * @param {unknown} payload 载荷
 * @returns {{ nodeId: string, advertisements: object[] } | null} 解析结果
 */
export function parseDiscoveryAnnounce(payload) {
	if (!isPlainObject(payload)) return null
	try {
		return {
			nodeId: assertDiscoveryNodeId(payload.nodeId),
			advertisements: Array.isArray(payload.advertisements) ? payload.advertisements : [],
		}
	}
	catch {
		return null
	}
}

/**
 * @param {unknown} payload 载荷
 * @returns {{ nodeId: string, requestId: string, limit: number } | null} 解析结果
 */
export function parseDiscoveryQuery(payload) {
	if (!isPlainObject(payload)) return null
	try {
		return {
			nodeId: assertDiscoveryNodeId(payload.nodeId),
			requestId: assertDiscoveryRequestId(payload.requestId),
			limit: Math.min(64, Math.max(1, Number(payload.limit) || 32)),
		}
	}
	catch {
		return null
	}
}

/**
 * @param {unknown} payload 载荷
 * @returns {{ requestId: string, nodeId: string, advertisements: object[] } | null} 解析结果
 */
export function parseDiscoveryQueryResponse(payload) {
	if (!isPlainObject(payload)) return null
	try {
		return {
			requestId: assertDiscoveryRequestId(payload.requestId),
			nodeId: assertDiscoveryNodeId(payload.nodeId),
			advertisements: Array.isArray(payload.advertisements) ? payload.advertisements : [],
		}
	}
	catch {
		return null
	}
}
