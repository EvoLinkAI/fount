/**
 * 冷归档按月联邦：明文 JSONL 分块（512KiB）serve / pull 组装。
 */
import { Buffer } from 'node:buffer'

import { encryptPlaintextToMultiParts } from '../../../../../../../scripts/p2p/files/assemble.mjs'
import { putChunk } from '../../../../../../../scripts/p2p/files/chunk_store.mjs'
import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'

import { digestArchiveMonthBody } from './monthDigest.mjs'

/**
 * @param {Array<{ hash: string, size: number }>} parts 加密分块
 * @returns {Array<{ hash: string, size: number, index: number }>} wire parts
 */
export function wirePartsFromEncParts(parts) {
	return parts.map((part, index) => ({
		hash: String(part.hash).trim().toLowerCase(),
		size: Number(part.size) || 0,
		index,
	}))
}

/**
 * 解析 wire parts 列表。
 * @param {unknown} raw wire 载荷
 * @returns {Array<{ hash: string, size: number, index: number }> | null} 解析结果；非法为 null
 */
export function parseArchiveMonthWireParts(raw) {
	if (!Array.isArray(raw) || !raw.length) return []
	/** @type {Array<{ hash: string, size: number, index: number }>} */
	const out = []
	for (const row of raw) {
		if (!row || typeof row !== 'object') return null
		const hash = String(row.hash || '').trim().toLowerCase()
		if (!isHex64(hash)) return null
		const index = Number(row.index)
		if (!Number.isInteger(index) || index < 0) return null
		out.push({ hash, size: Math.max(0, Number(row.size) || 0), index })
	}
	out.sort((a, b) => a.index - b.index)
	for (let i = 0; i < out.length; i++)
		if (out[i].index !== i) return null
	return out
}

/**
 * 将月 JSONL 切分写入 chunk store，返回联邦 meta。
 * @param {string} username replica
 * @param {string} bodyUtf8 月 JSONL 明文
 * @returns {Promise<{ digest: string, parts: Array<{ hash: string, size: number, index: number }> }>} 联邦 meta
 */
export async function prepareArchiveMonthChunkMeta(username, bodyUtf8) {
	const body = String(bodyUtf8 ?? '')
	const { digest } = digestArchiveMonthBody(body)
	const enc = encryptPlaintextToMultiParts(Buffer.from(body, 'utf8'), 'plain')
	for (const part of enc.parts)
		await putChunk(username, part.hash, part.raw)
	return { digest, parts: wirePartsFromEncParts(enc.parts) }
}

/**
 * @param {Array<{ hash: string, index: number }>} parts wire parts（已排序）
 * @param {Record<string, Uint8Array | Buffer>} fetched hash → bytes
 * @returns {string} 重组 JSONL 明文
 */
export function assembleArchiveMonthBodyFromParts(parts, fetched) {
	const sorted = [...parts].sort((a, b) => a.index - b.index)
	return Buffer.concat(sorted.map(part => Buffer.from(fetched[part.hash] || []))).toString('utf8')
}

/**
 * 从 chunk meta 拉块并校验 digest。
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} slot 联邦槽
 * @param {{ digest?: string, parts?: Array<{ hash: string, size: number, index: number }>, complete?: boolean, body?: string }} candidate 候选
 * @returns {Promise<string | null>} 明文 body；失败 null
 */
export async function resolveArchiveMonthCandidateBody(username, groupId, slot, candidate) {
	if (typeof candidate.body === 'string' && candidate.body.length) return null
	if (candidate.complete === false) return null
	const digest = String(candidate.digest || '').trim().toLowerCase()
	if (!isHex64(digest)) return null
	const parts = candidate.parts ?? []
	if (!Array.isArray(parts)) return null
	if (!parts.length) {
		const emptyDigest = digestArchiveMonthBody('').digest
		return emptyDigest === digest ? '' : null
	}
	const parsed = parseArchiveMonthWireParts(parts)
	if (parsed === null) return null
	const hashes = parsed.map(part => part.hash)
	if (!slot?.getRoster?.()?.length) return null
	const { fetchChunksFromRoster } = await import('../federation/chunks.mjs')
	const { fetched, missing } = await fetchChunksFromRoster(slot, username, groupId, hashes)
	if (missing.length) return null
	const body = assembleArchiveMonthBodyFromParts(parsed, fetched)
	if (digestArchiveMonthBody(body).digest !== digest) return null
	return body
}
