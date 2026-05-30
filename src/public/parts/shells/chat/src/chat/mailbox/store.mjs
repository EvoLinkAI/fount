/**
 * Mailbox store-and-forward（明文元数据 + 已签名/已加密 envelope）。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isHex64, normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import {
	defaultTtlMsForTier,
	sortMailboxForRetention,
} from '../../../../../../../scripts/p2p/mailbox_importance.mjs'
import {
	MAX_BUCKET_BYTES,
	MAX_BUCKET_ENTRIES,
	MAX_MAILBOX_BYTES,
	MAX_MAILBOX_ENTRIES,
	mailboxBucketKey,
	mailboxRecordBytes,
	pruneMailboxBuckets,
	pruneMailboxGlobalFair,
} from '../../../../../../../scripts/p2p/mailbox_prune.mjs'
import { mailboxStorePath } from '../lib/paths.mjs'

/**
 *
 */
export { MAX_BUCKET_BYTES, MAX_BUCKET_ENTRIES, mailboxBucketKey, mailboxRecordBytes }
const MAX_ENTRIES = MAX_MAILBOX_ENTRIES
const MAX_BYTES = MAX_MAILBOX_BYTES
const MAX_ENTRY_BYTES = 256 * 1024
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000

/**
 * @typedef {{
 *   id: string,
 *   toPubKeyHash: string,
 *   dmSessionTag?: string,
 *   groupId?: string,
 *   channelId?: string,
 *   envelope: object,
 *   storedAt: number,
 *   expiresAt: number,
 *   fromNodeHash: string,
 *   hop: number,
 *   tier?: 'trusted' | 'normal' | 'quarantine',
 *   importance?: number,
 * }} MailboxRecord
 */

/**
 * @param {string} username 用户
 * @returns {Promise<MailboxRecord[]>} 全部记录
 */
async function readAll(username) {
	try {
		const text = await readFile(mailboxStorePath(username), 'utf8')
		return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
			.filter(record => record.tier === 'trusted' || record.tier === 'normal' || record.tier === 'quarantine')
	}
	catch { return [] }
}

/**
 * @param {string} username 用户
 * @param {MailboxRecord[]} rows 记录
 * @returns {Promise<void>}
 */
/**
 * 按 tier 优先保留高重要性记录后再做桶/全局裁剪。
 * @param {MailboxRecord[]} rows 记录
 * @returns {MailboxRecord[]} 裁剪后
 */
function pruneByImportanceThenFair(rows) {
	const sorted = sortMailboxForRetention(rows)
	let kept = pruneMailboxBuckets(sorted)
	kept = pruneMailboxGlobalFair(kept)
	return kept
}

/**
 * @param {string} username 用户
 * @param {MailboxRecord[]} rows 记录
 * @returns {Promise<void>}
 */
async function writeAll(username, rows) {
	const path = mailboxStorePath(username)
	await mkdir(dirname(path), { recursive: true })
	const now = Date.now()
	let kept = rows.filter(record => record.expiresAt > now)
	kept = pruneByImportanceThenFair(kept)
	await writeFile(path, kept.map(record => JSON.stringify(record)).join('\n') + (kept.length ? '\n' : ''), 'utf8')
}

/**
 * @param {object} envelope DAG 事件或密文包
 * @returns {string} 去重 id
 */
export function mailboxEnvelopeId(envelope) {
	if (envelope?.id) return String(envelope.id).trim().toLowerCase()
	return createHash('sha256').update(JSON.stringify(envelope)).digest('hex')
}

/**
 * @param {string} username 用户
 * @param {object} record 不含 id 的记录字段
 * @returns {Promise<boolean>} 是否新写入
 */
export async function storeMailboxRecord(username, record) {
	if (JSON.stringify(record.envelope).length > MAX_ENTRY_BYTES) return false
	const toPubKeyHash = normalizeHex64(record.toPubKeyHash)
	if (!isHex64(toPubKeyHash)) return false
	const tier = record.tier === 'trusted' || record.tier === 'normal' || record.tier === 'quarantine'
		? record.tier
		: null
	if (!tier) return false
	if (tier === 'quarantine' && (Number(record.hop) || 0) > 0) return false
	const id = record.id || mailboxEnvelopeId(record.envelope)
	const rows = await readAll(username)
	if (rows.some(row => row.id === id)) return false
	const ttlMs = Number(record.ttlMs) || defaultTtlMsForTier(tier)
	rows.push({
		id,
		toPubKeyHash,
		dmSessionTag: record.dmSessionTag?.trim().toLowerCase() || undefined,
		groupId: record.groupId || undefined,
		channelId: record.channelId || undefined,
		envelope: record.envelope,
		storedAt: Date.now(),
		expiresAt: Date.now() + ttlMs,
		fromNodeHash: String(record.fromNodeHash || '').trim(),
		hop: Math.min(3, Math.max(0, Number(record.hop) || 0)),
		tier,
		importance: Number.isFinite(Number(record.importance)) ? Number(record.importance) : undefined,
	})
	await writeAll(username, rows)
	return true
}

/**
 * @param {string} username 用户
 * @param {string} toPubKeyHash 收件人
 * @returns {Promise<string[]>} 记录 id 列表
 */
export async function listMailboxIdsForRecipient(username, toPubKeyHash) {
	const recipient = normalizeHex64(toPubKeyHash)
	return (await readAll(username))
		.filter(record => record.toPubKeyHash === recipient)
		.map(record => record.id)
}

/**
 * @param {string} username 用户
 * @param {string[]} ids id 列表
 * @returns {Promise<MailboxRecord[]>} 匹配记录
 */
export async function getMailboxRecords(username, ids) {
	const want = new Set(ids.map(id => String(id).trim().toLowerCase()))
	return (await readAll(username)).filter(record => want.has(record.id))
}

/**
 * @param {string} username 用户
 * @param {string[]} ids 已交付 id
 * @returns {Promise<void>}
 */
export async function deleteMailboxRecords(username, ids) {
	const drop = new Set(ids)
	await writeAll(username, (await readAll(username)).filter(record => !drop.has(record.id)))
}

/**
 * @param {string} username 用户
 * @param {string} toPubKeyHash 收件人
 * @returns {Promise<MailboxRecord[]>} 匹配记录
 */
export async function takeMailboxForRecipient(username, toPubKeyHash) {
	const recipient = normalizeHex64(toPubKeyHash)
	return (await readAll(username)).filter(record => record.toPubKeyHash === recipient)
}

/**
 * @param {string} username 用户
 * @returns {Promise<number>} 未过期 mailbox 条数
 */
export async function countMailboxPending(username) {
	const now = Date.now()
	return (await readAll(username)).filter(record => record.expiresAt > now).length
}
