/**
 * 【文件】`events/wire.mjs` — 联邦 DAG 事件 wire 净化。
 * 【职责】在持久化或 Gossip 前剥离非 canonical 的本地扩展字段，保证对端验签域一致。
 * 【原理】§6 canonical 要求 `events.jsonl` 仅含验签相关字段 + `id`/`signature`/`senderPubKey`；`receivedAt`、`isRemote` 等键不得进入主事件流。
 * 【数据结构】输入/输出均为普通事件对象；`WIRE_STRIP_KEYS` 为需删除的键集合。
 * 【关联】`storage.mjs`、`append.mjs`、`remoteIngest.mjs`、`events/meta.mjs`。
 */
/**
 * 联邦互操作：剥离未签名的本地扩展字段，仅保留验签域 + id/signature/senderPubKey。
 */

import { isPlainObject } from '../lib/wireIngress.mjs'

/** 不得进入 events.jsonl 或 Gossip 线的扩展键（§6 canonical）。 */
const WIRE_STRIP_KEYS = new Set(['receivedAt', 'isRemote'])

/**
 * @param {unknown} ev 原始事件行
 * @returns {object} 可持久化 / 对端传播的副本
 */
export function sanitizeFederatedEvent(ev) {
	if (!isPlainObject(ev)) return ev
	const out = { ...ev }
	for (const key of WIRE_STRIP_KEYS) delete out[key]
	return out
}

/**
 * @param {object[]} events 事件列表
 * @returns {object[]} 净化后的数组
 */
export function sanitizeFederatedEvents(events) {
	return events.map(sanitizeFederatedEvent)
}
