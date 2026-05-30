/**
 * 跨 MQTT 分区桥接（应用层中继，带去重/TTL）。
 */
import { createHash } from 'node:crypto'

import { isRtcRoomOverloaded } from '../../../../../../../scripts/p2p/rtc_connection_budget.mjs'

/** @type {Map<string, number>} */
const bridgeDedupe = new Map()
const DEDUPE_MS = 30_000
const DEFAULT_BRIDGE_TTL = 2

/** 桥接优先级：数字越小越关键（过载时丢弃高数字） */
const BRIDGE_ACTION_PRIORITY = {
	dag_event: 0,
	mailbox_give: 2,
	mailbox_put: 4,
	mailbox_want: 4,
	gossip_request: 5,
	gossip_response: 5,
	fed_chunk_data: 6,
	fed_chunk_get: 6,
	fed_partition_bridge: 8,
}

const BRIDGE_FORWARD_MAX_PER_MIN = 120
/** @type {Map<string, { count: number, windowStart: number }>} */
const bridgeForwardBuckets = new Map()

/**
 * @param {string} key 去重键
 * @returns {boolean} 首次见到为 true
 */
export function takePartitionBridgeSlot(key) {
	const now = Date.now()
	if (bridgeDedupe.size > 5000)
		for (const [k, t] of bridgeDedupe)
			if (now - t > DEDUPE_MS) bridgeDedupe.delete(k)
	if (bridgeDedupe.has(key)) return false
	bridgeDedupe.set(key, now)
	return true
}

/**
 * @param {object} envelope 桥接载荷
 * @returns {string} 去重 id
 */
export function partitionBridgeDedupeId(envelope) {
	if (envelope?.dedupeId) return String(envelope.dedupeId)
	return createHash('sha256').update(JSON.stringify(envelope?.payload ?? envelope), 'utf8').digest('hex')
}

/**
 * @param {object} opts 参数
 * @param {string} opts.sourcePartition 来源分区
 * @param {string} opts.targetPartition 目标分区
 * @param {string} opts.actionName Trystero action
 * @param {unknown} opts.payload 载荷
 * @param {number} [opts.ttl] 剩余跳数
 * @returns {object} 桥接信封
 */
export function buildPartitionBridgeEnvelope(opts) {
	return {
		sourcePartition: opts.sourcePartition,
		targetPartition: opts.targetPartition,
		actionName: opts.actionName,
		payload: opts.payload,
		ttl: Math.max(0, Number(opts.ttl ?? DEFAULT_BRIDGE_TTL)),
		dedupeId: partitionBridgeDedupeId({ payload: opts.payload, action: opts.actionName }),
	}
}

/**
 * @param {string} actionName Trystero action
 * @returns {number} 优先级（越大越先丢弃）
 */
export function partitionBridgeActionPriority(actionName) {
	return BRIDGE_ACTION_PRIORITY[String(actionName || '')] ?? 5
}

/**
 * @param {string} roomKey 房间键
 * @param {string} actionName action
 * @param {object} [rtcLimits] RTC 限额
 * @returns {boolean} 过载时是否应丢弃该桥接
 */
export function shouldDropPartitionBridgeUnderLoad(roomKey, actionName, rtcLimits = {}) {
	if (!isRtcRoomOverloaded(roomKey, rtcLimits)) return false
	return partitionBridgeActionPriority(actionName) >= 4
}

/**
 * @param {string} roomKey 房间键
 * @returns {boolean} 是否允许继续转发桥接包
 */
export function takePartitionBridgeForwardSlot(roomKey) {
	const key = String(roomKey || '')
	const now = Date.now()
	let bucket = bridgeForwardBuckets.get(key)
	if (!bucket || now - bucket.windowStart >= 60_000)
		bucket = { count: 0, windowStart: now }
	if (bucket.count >= BRIDGE_FORWARD_MAX_PER_MIN) {
		bridgeForwardBuckets.set(key, bucket)
		return false
	}
	bucket.count++
	bridgeForwardBuckets.set(key, bucket)
	return true
}

/**
 * 经已连接分区向目标分区桥接 action。
 * @param {object} slot 源分区 FederationSlot（含 sendPartitionBridge）
 * @param {object} opts 参数
 * @param {string} opts.targetPartition 目标分区
 * @param {string} opts.actionName action
 * @param {unknown} opts.payload 载荷
 * @param {string | null} [opts.peerId] 目标 peer；null 为房内广播
 * @param {number} [opts.ttl] TTL
 * @returns {boolean} 是否已发送
 */
export function sendPartitionBridgeFromSlot(slot, opts) {
	if (!slot?.sendPartitionBridge) return false
	const envelope = buildPartitionBridgeEnvelope({
		sourcePartition: slot.partitionId,
		targetPartition: opts.targetPartition,
		actionName: opts.actionName,
		payload: opts.payload,
		ttl: opts.ttl,
	})
	slot.sendPartitionBridge(envelope, opts.peerId ?? null)
	return true
}
