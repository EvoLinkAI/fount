/**
 * 【文件】federation/wireSchemas.mjs
 * 【职责】Trystero 联邦线消息的结构化解析：tip ping/pong、gossip_request、channel_history_want，校验 id 格式。
 * 【原理】轻量 parse 函数在 room 入站 handler 最前端调用，非法载荷直接丢弃，避免污染 DAG/gossip 状态机。wantIds 去重并过滤 EVENT_ID_HEX。
 * 【数据结构】parseGossipRequest→{ wantIds, ttl, requesterNodeHash, archiveSummary }；parseFedTipPing/Pong；parseChannelHistoryWant 排除 requesterNodeHash=本机。
 * 【关联】room.mjs、registry EVENT_ID_HEX、scripts/p2p/wire_ingress isPlainObject。
 */
import { isPlainObject } from '../../../../../../../scripts/p2p/wire_ingress.mjs'

import { parsePullAttestation } from './fedPullWire.mjs'
import { EVENT_ID_HEX } from './registry.mjs'

/**
 * @param {unknown} payload Trystero 载荷
 * @returns {{ nodeHash: string, tips: unknown } | null} 解析结果
 */
export function parseFedTipPing(payload) {
	if (!isPlainObject(payload)) return null
	const nodeHash = String(payload.nodeHash || '').trim()
	if (!nodeHash) return null
	return { nodeHash, tips: payload.tips, archiveSummary: payload.archiveSummary }
}

/**
 * @param {unknown} payload Trystero 载荷
 * @returns {{ tips: unknown } | null} 解析结果
 */
export function parseFedTipPong(payload) {
	if (!isPlainObject(payload)) return null
	const archiveSummary = isPlainObject(payload.archiveSummary) ? payload.archiveSummary : null
	return { tips: payload.tips, archiveSummary }
}

/**
 * @param {unknown} payload gossip_request 载荷
 * @returns {{ wantIds: string[], ttl: number, requesterNodeHash: string, archiveSummary: unknown, attestation: import('./fedPullWire.mjs').PullAttestation } | null} 解析结果
 */
export function parseGossipRequest(payload) {
	if (!isPlainObject(payload)) return null
	const wantIds = Array.isArray(payload.wantIds)
		? [...new Set(payload.wantIds.map(id => String(id).trim().toLowerCase()).filter(id => EVENT_ID_HEX.test(id)))]
		: []
	if (!wantIds.length) return null
	const ttl = Number(payload.ttl)
	const requesterNodeHash = String(payload.requesterNodeHash || '').trim()
	const attestation = parsePullAttestation(payload.attestation)
	if (!Number.isFinite(ttl) || !requesterNodeHash || !attestation) return null
	if (attestation.wantIds?.length) {
		const attSet = new Set(attestation.wantIds)
		if (wantIds.some(id => !attSet.has(id))) return null
	}
	return { wantIds, ttl, requesterNodeHash, archiveSummary: payload.archiveSummary, attestation }
}

/**
 * @param {unknown} payload channel_history_want 载荷
 * @param {string} localNodeHash 本节点 hash
 * @param {string} groupId 群 ID（attestation 校验用）
 * @returns {{ requesterNodeHash: string, requestId: string, channelId: string, before?: string, limit: number, attestation: import('./fedPullWire.mjs').PullAttestation } | null} 解析结果
 */
export function parseChannelHistoryWant(payload, localNodeHash, groupId) {
	if (!isPlainObject(payload)) return null
	const requesterNodeHash = String(payload.requesterNodeHash || '').trim()
	const requestId = String(payload.requestId || '').trim()
	const channelId = String(payload.channelId || '').trim()
	const attestation = parsePullAttestation(payload.attestation)
	if (!requesterNodeHash || !requestId || !channelId || requesterNodeHash === localNodeHash) return null
	if (!attestation || attestation.groupId !== String(groupId || '').trim() || attestation.requestId !== requestId)
		return null
	const before = String(payload.before || '').trim()
	return {
		requesterNodeHash,
		requestId,
		channelId,
		before: EVENT_ID_HEX.test(before) ? before : undefined,
		limit: Math.min(500, Math.max(1, Number(payload.limit) || 50)),
		attestation,
	}
}
