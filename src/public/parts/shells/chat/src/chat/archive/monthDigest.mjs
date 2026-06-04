/**
 * 冷归档单月正文 canonical digest 与信誉仲裁。
 */
import { createHash } from 'node:crypto'

import { canonicalStringify } from '../../../../../../../scripts/p2p/canonical_json.mjs'
import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { pickNodeScoreFromReputation } from '../../../../../../../scripts/p2p/reputation_pick_score.mjs'

import { validateArchiveSealForGroup } from './seal.mjs'

/** 至少 2 个独立 peer 同 digest 时可接受（无正信誉时） */
export const ARCHIVE_QUORUM_PEER_MIN = 2

/**
 * @param {object} repFile reputation.json
 * @returns {(username: string, peerNodeHash: string, groupId: string) => number} 评分函数
 */
function makeReputationScoreFn(repFile) {
	return function reputationScore(_username, peerNodeHash, groupId) {
		return pickNodeScoreFromReputation(repFile, peerNodeHash, groupId)
	}
}

/**
 * @param {object} snap PostSnapshot
 * @returns {object} digest 用 canonical 体（不含易变 display 缓存）
 */
export function canonicalSnapshotForDigest(snap) {
	return {
		eventId: String(snap.eventId || '').trim().toLowerCase(),
		channelId: String(snap.channelId || 'default').trim(),
		hlc: snap.hlc,
		timestamp: snap.timestamp,
		sender: String(snap.sender || '').trim().toLowerCase(),
		charId: snap.charId ?? null,
		content: snap.content,
		reactions: snap.reactions,
		pinned: !!snap.pinned,
		deleted: !!snap.deleted,
		prev_event_ids: Array.isArray(snap.prev_event_ids)
			? [...snap.prev_event_ids].map(id => String(id).trim().toLowerCase()).filter(isHex64).sort()
			: undefined,
	}
}

/**
 * @param {string} body JSONL 明文
 * @returns {{ digest: string, snapshots: object[] }} digest hex 与解析行
 */
export function digestArchiveMonthBody(body) {
	/** @type {object[]} */
	const snapshots = []
	for (const line of String(body || '').split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			snapshots.push(JSON.parse(trimmed))
		}
		catch {
			return { digest: '', snapshots: [] }
		}
	}
	snapshots.sort((a, b) => String(a.eventId).localeCompare(String(b.eventId)))
	const parts = snapshots.map(snap => canonicalStringify(canonicalSnapshotForDigest(snap)))
	const digest = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex')
	return { digest, snapshots }
}

/**
 * @param {object} manifest archive manifest
 * @param {string} channelId 频道
 * @param {string} month `YYYY-MM`
 * @param {object[]} snapshots PostSnapshot 列表
 * @returns {{ ok: boolean, reason?: string }} inventory 是否通过
 */
export function inventoryCheck(manifest, channelId, month, snapshots) {
	const idMap = manifest.archivedEventIds?.[channelId] || {}
	const allowed = new Set(
		Object.entries(idMap).filter(([, m]) => m === month).map(([id]) => id),
	)
	if (!snapshots.length) return { ok: false, reason: 'empty_body' }
	for (const snap of snapshots) {
		const id = String(snap.eventId || '').trim().toLowerCase()
		if (!isHex64(id) || !allowed.has(id))
			return { ok: false, reason: 'inventory_mismatch' }
	}
	return { ok: true }
}

/**
 * @param {Array<{ peerNodeHash: string, body: string, seal?: object | null, complete?: boolean }>} candidates 各 peer 应答
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} manifest archive manifest
 * @param {string} channelId 频道
 * @param {string} month `YYYY-MM`
 * @param {{ pickScore?: (username: string, peerNodeHash: string, groupId: string) => number }} [opts] 测试可注入 pickScore
 * @returns {Promise<{ winner: object | null, digest: string, reason: string }>} 仲裁结果
 */
export async function pickArchiveMonthByReputation(candidates, username, groupId, manifest, channelId, month, opts = {}) {
	/** @type {(username: string, peer: string, groupId: string) => number} */
	let scoreOf = opts.pickScore
	if (!scoreOf) {
		const { loadReputation } = await import('../../../../../../../scripts/p2p/reputation_user.mjs')
		const rep = loadReputation(username)
		scoreOf = makeReputationScoreFn(rep)
	}
	/** @type {Map<string, { digest: string, snapshots: object[], peers: string[], seal: object | null }>} */
	const byDigest = new Map()
	for (const row of candidates) {
		if (!row.complete || !row.body) continue
		const peer = String(row.peerNodeHash || '').trim()
		if (!peer) continue
		if (row.seal && !await validateArchiveSealForGroup(username, groupId, row.seal))
			continue
		const { digest, snapshots } = digestArchiveMonthBody(row.body)
		if (!digest) continue
		const inv = inventoryCheck(manifest, channelId, month, snapshots)
		if (!inv.ok) continue
		const bucket = byDigest.get(digest) || {
			digest,
			snapshots,
			peers: [],
			seal: row.seal || null,
		}
		bucket.peers.push(peer)
		if (row.seal) bucket.seal = row.seal
		byDigest.set(digest, bucket)
	}
	if (!byDigest.size) return { winner: null, digest: '', reason: 'no_valid_candidate' }

	const expectedDigest = manifest.monthDigests?.[channelId]?.[month]
	/** @type {{ digest: string, score: number, bucket: object }[]} */
	const ranked = []
	for (const bucket of byDigest.values()) {
		let score = 0
		for (const peer of bucket.peers)
			score = Math.max(score, scoreOf(username, peer, groupId))
		if (expectedDigest && bucket.digest === expectedDigest) score += 0.001
		ranked.push({ digest: bucket.digest, score, bucket })
	}
	ranked.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score
		if (b.bucket.peers.length !== a.bucket.peers.length)
			return b.bucket.peers.length - a.bucket.peers.length
		return a.digest.localeCompare(b.digest)
	})

	const best = ranked[0]
	const quorumOk = best.score > 0
		|| best.bucket.peers.length >= ARCHIVE_QUORUM_PEER_MIN
	if (!quorumOk) return { winner: null, digest: '', reason: 'quorum_failed' }

	return {
		winner: {
			body: best.bucket.snapshots.map(JSON.stringify).join('\n') + '\n',
			seal: best.bucket.seal,
			channelId,
			utcMonth: month,
			peers: best.bucket.peers,
		},
		digest: best.digest,
		reason: 'ok',
	}
}

/**
 * 从磁盘月文件刷新 manifest.monthDigests。
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道
 * @param {string} month `YYYY-MM`
 * @param {object} manifest 可变 manifest
 * @returns {Promise<void>}
 */
export async function refreshManifestMonthDigest(username, groupId, channelId, month, manifest) {
	const { readFile } = await import('node:fs/promises')
	const { channelArchivePath } = await import('../lib/paths.mjs')
	try {
		const body = await readFile(channelArchivePath(username, groupId, channelId, month), 'utf8')
		const { digest } = digestArchiveMonthBody(body)
		if (!digest) return
		if (!manifest.monthDigests) manifest.monthDigests = {}
		if (!manifest.monthDigests[channelId]) manifest.monthDigests[channelId] = {}
		manifest.monthDigests[channelId][month] = digest
	}
	catch { /* missing file */ }
}
