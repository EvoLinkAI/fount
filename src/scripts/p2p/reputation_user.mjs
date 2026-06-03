import { loadData, saveData } from '../../server/setting_loader.mjs'
import { createLruMap } from '../memo.mjs'

import { assertHex64, isHex64, normalizeHex64 } from './hexIds.mjs'
import {
	clampReputationScore,
	computeRepMaxEff,
	seedReputationFromIntro,
	subjectiveSlashPenalty,
} from './reputation.mjs'
import {
	RELAY_BUMP_DEDUPE_MS,
	relayBumpIsDuplicate,
} from './reputation_relay_dedupe.mjs'
import { invalidateTrustGraphCache } from './trust_graph_cache.mjs'
import { recordWantIdsBackoff, wantIdsPeerKey } from './want_ids.mjs'

const DATA_NAME = 'reputation'

/** §9 默认：5 分钟内同一邻居「整批 want 本地全无」累计次数 */
const WANT_UNKNOWN_WINDOW_MS = 5 * 60 * 1000
const WANT_UNKNOWN_THRESHOLD = 3
const PENALTY_UNKNOWN_WANT = 0.12
const PENALTY_MESSAGE_RATE = 0.15
const CHUNK_STORE_REP_BUMP = 0.03
const CHUNK_FETCH_FAIL_PENALTY = 0.08
const RELAY_REP_BUMP = 0.02
const DEFAULT_SLASH_ALERT_TTL_MS = 86_400_000
const MAX_RELAY_BUMP_SEEN = 2000

/**
 * @typedef {{
 *   schema: number
 *   byNodeHash: Record<string, { score: number, scopes?: Record<string, number> }>
 *   wantUnknownHits: Array<{ peerNodeHash: string, t: number }>
 *   relayBumpSeen: Array<{ peerNodeHash: string, key: string, t: number }>
 * }} ReputationFile
 */

/**
 *
 */
export { relayBumpIsDuplicate } from './reputation_relay_dedupe.mjs'

/**
 * @param {ReputationFile} data 信誉表
 * @param {string} nodeId 64 hex
 * @returns {{ score: number, scopes: Record<string, number> }} 节点行
 */
function repRow(data, nodeId) {
	const row = data.byNodeHash[nodeId] || { score: 0 }
	return {
		score: Number(row.score ?? 0),
		scopes: row.scopes ? { ...row.scopes } : {},
	}
}

/**
 * 按群 scope 调整信誉；无 groupId 时更新全局 score。
 * @param {ReputationFile} data 信誉表
 * @param {string} nodeId 64 hex
 * @param {string} groupId 群 ID
 * @param {number} delta 增量
 * @returns {void}
 */
function adjustNodeReputation(data, nodeId, groupId, delta) {
	const row = repRow(data, nodeId)
	const gid = String(groupId || '').trim()
	if (gid) {
		const prev = Number(row.scopes[gid] ?? row.score ?? 0)
		row.scopes[gid] = clampReputationScore(prev + delta)
	}
	else
		row.score = clampReputationScore(row.score + delta)
	data.byNodeHash[nodeId] = row
}

/**
 * @param {unknown} raw 磁盘 JSON
 * @returns {ReputationFile} 规范化后的信誉文件对象
 */
function normalizeRepFile(raw) {
	const file = raw || {}
	/** @type {Record<string, { score: number, scopes?: Record<string, number> }>} */
	const byNodeHash = { ...file.byNodeHash || {} }
	for (const nodeId of Object.keys(byNodeHash)) {
		const row = byNodeHash[nodeId] || {}
		const score = Number(row.score)
		byNodeHash[nodeId] = {
			score: clampReputationScore(Number.isFinite(score) ? score : 0),
			...row.scopes ? { scopes: { ...row.scopes } } : {},
		}
	}
	const wantUnknownHits = (file.wantUnknownHits || [])
		.filter(hit => hit?.peerNodeHash && Number.isFinite(hit.t))
		.map(hit => ({ peerNodeHash: String(hit.peerNodeHash), t: Number(hit.t) }))
	const relayBumpSeen = (file.relayBumpSeen || [])
		.filter(hit => hit?.peerNodeHash && hit?.key && Number.isFinite(hit.t))
		.map(hit => ({
			peerNodeHash: String(hit.peerNodeHash),
			key: String(hit.key),
			t: Number(hit.t),
		}))
	return { schema: 1, byNodeHash, wantUnknownHits, relayBumpSeen }
}

const REPUTATION_BY_USER_MAX = 256

/** @type {ReturnType<typeof createLruMap<string, ReputationFile>>} */
const reputationByUser = createLruMap(REPUTATION_BY_USER_MAX)

/** @type {Map<string, Promise<void>>} */
const reputationWriteChains = new Map()

/**
 * 串行化信誉表突变，避免跨 await 的陈旧闭包覆盖。
 * @param {string} username 用户
 * @param {(data: ReputationFile) => void | Promise<void>} mutator 突变
 * @returns {Promise<void>}
 */
function mutateReputation(username, mutator) {
	const prev = reputationWriteChains.get(username) || Promise.resolve()
	const task = prev.catch(() => { }).then(async () => {
		const data = loadReputation(username)
		await mutator(data)
		saveReputation(username, data)
	})
	const finalTask = task.finally(() => {
		if (reputationWriteChains.get(username) === finalTask)
			reputationWriteChains.delete(username)
	})
	reputationWriteChains.set(username, finalTask)
	return task
}

/**
 * @param {string} username 用户
 * @returns {ReputationFile} 用户级信誉表
 */
export function loadReputation(username) {
	let cached = reputationByUser.get(username)
	if (cached) {
		reputationByUser.touch(username, cached)
		return cached
	}
	cached = normalizeRepFile(loadData(username, DATA_NAME))
	reputationByUser.touch(username, cached)
	return cached
}

/**
 * @param {string} username 用户
 * @param {ReputationFile} data 信誉表
 * @returns {void}
 */
export function saveReputation(username, data) {
	const clean = normalizeRepFile(data)
	const now = Date.now()
	clean.wantUnknownHits = clean.wantUnknownHits.filter(h => now - h.t <= WANT_UNKNOWN_WINDOW_MS)
	clean.relayBumpSeen = clean.relayBumpSeen.filter(h => now - h.t <= RELAY_BUMP_DEDUPE_MS)
	if (clean.relayBumpSeen.length > MAX_RELAY_BUMP_SEEN)
		clean.relayBumpSeen = clean.relayBumpSeen.slice(-MAX_RELAY_BUMP_SEEN)
	const store = loadData(username, DATA_NAME)
	Object.assign(store, clean)
	saveData(username, DATA_NAME)
	reputationByUser.touch(username, clean)
	invalidateTrustGraphCache(username)
}

/**
 * @param {string} username 用户
 * @param {string} peerNodeHash 对端节点
 * @param {string} [dedupeKey] 去重键
 * @returns {void}
 */
export function bumpReputationOnRelay(username, peerNodeHash, dedupeKey) {
	const id = String(peerNodeHash || '').trim()
	if (!id) return
	const key = String(dedupeKey || `conn:${id}`).trim()
	void mutateReputation(username, data => {
		const now = Date.now()
		data.relayBumpSeen = (data.relayBumpSeen || []).filter(h => now - h.t <= RELAY_BUMP_DEDUPE_MS)
		if (relayBumpIsDuplicate(data.relayBumpSeen, id, key, now)) return
		data.relayBumpSeen.push({ peerNodeHash: id, key, t: now })
		const prev = Number(data.byNodeHash[id]?.score ?? 0)
		data.byNodeHash[id] = { score: clampReputationScore(prev + RELAY_REP_BUMP) }
	})
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID（want_ids backoff 仍按群）
 * @param {string} peerNodeHash 请求方
 * @returns {void}
 */
export function recordGossipAllUnknownWant(username, groupId, peerNodeHash) {
	void mutateReputation(username, data => {
		const now = Date.now()
		data.wantUnknownHits = data.wantUnknownHits.filter(h => now - h.t <= WANT_UNKNOWN_WINDOW_MS)
		data.wantUnknownHits.push({ peerNodeHash, t: now })
		const recent = data.wantUnknownHits.filter(h => h.peerNodeHash === peerNodeHash)
		if (recent.length >= WANT_UNKNOWN_THRESHOLD) {
			adjustNodeReputation(data, peerNodeHash, groupId, -PENALTY_UNKNOWN_WANT)
			data.wantUnknownHits = data.wantUnknownHits.filter(h => h.peerNodeHash !== peerNodeHash)
			recordWantIdsBackoff(wantIdsPeerKey(username, groupId, peerNodeHash))
		}
	})
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 scope（want_ids backoff / scope 分）
 * @param {string} peerNodeHash 对端
 * @returns {void}
 */
export function recordMessageRateViolation(username, groupId, peerNodeHash) {
	const id = String(peerNodeHash || '').trim()
	if (!id) return
	void mutateReputation(username, data => {
		adjustNodeReputation(data, id, groupId, -PENALTY_MESSAGE_RATE)
	})
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 scope
 * @param {string} storagePeerKey 责任方
 * @returns {void}
 */
export function bumpChunkStorageReputation(username, groupId, storagePeerKey) {
	const id = String(storagePeerKey || '').trim()
	if (!id) return
	void mutateReputation(username, data => {
		adjustNodeReputation(data, id, groupId, CHUNK_STORE_REP_BUMP)
	})
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 scope
 * @param {string} blamePeerKey 责任方
 * @returns {void}
 */
export function penalizeChunkStorageFailure(username, groupId, blamePeerKey) {
	const id = String(blamePeerKey || '').trim()
	if (!id) return
	void mutateReputation(username, data => {
		adjustNodeReputation(data, id, groupId, -CHUNK_FETCH_FAIL_PENALTY)
	})
}

/**
 * @param {object | null | undefined} groupSettings 群设置
 * @returns {number} 毫秒
 */
export function resolveSlashAlertTtlMs(groupSettings) {
	const n = Number(groupSettings?.slashAlertTtl)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SLASH_ALERT_TTL_MS
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 scope
 * @param {object} alert VOLATILE slash 载荷
 * @returns {boolean} 是否已应用
 */
export function applyVolatileSlashAlert(username, groupId, alert) {
	const expiresAt = Number(alert?.expiresAt)
	if (Number.isFinite(expiresAt) && Date.now() > expiresAt) return false
	const target = normalizeHex64(alert?.targetPubKeyHash)
	const sender = normalizeHex64(alert?.sender)
	if (!isHex64(target) || !isHex64(sender)) return false
	const claim = Number.isFinite(Number(alert?.claim)) ? Number(alert.claim) : 0.2
	void mutateReputation(username, data => {
		const repMaxEff = computeRepMaxEff(data)
		const repSender = Number(data.byNodeHash[sender]?.score ?? 0)
		const penalty = subjectiveSlashPenalty(claim, repSender, repMaxEff, false)
		adjustNodeReputation(data, target, groupId, -penalty)
	})
	return true
}

/**
 * @param {string} senderPubKeyHash 签发者
 * @param {{ targetPubKeyHash: string, claim?: number }} content Slash 内容
 * @param {object} [groupSettings] 群设置
 * @returns {object} VOLATILE 载荷
 */
export function buildAndApplyUnverifiedSlashAlert(senderPubKeyHash, content, groupSettings = {}) {
	const targetPubKeyHash = assertHex64(content.targetPubKeyHash, 'slash target')
	const claim = Number.isFinite(Number(content.claim)) ? Number(content.claim) : 0.2
	const sender = assertHex64(senderPubKeyHash, 'slash sender')
	const ttl = resolveSlashAlertTtlMs(groupSettings)
	return {
		type: 'reputation_slash_alert',
		targetPubKeyHash,
		sender,
		claim,
		expiresAt: Date.now() + ttl,
	}
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {object} event reputation_slash 事件
 * @param {(username: string, groupId: string) => Promise<object[]>} readEvents 读 DAG 事件
 * @returns {Promise<void>}
 */
export async function applySubjectiveSlashFromEvent(username, groupId, event, readEvents) {
	if (event?.type !== 'reputation_slash') return
	const content = event.content || {}
	const target = content.targetPubKeyHash.trim().toLowerCase()
	const sender = event.sender.trim().toLowerCase()

	await mutateReputation(username, async data => {
		const repMaxEff = computeRepMaxEff(data)
		const repSender = Number(data.byNodeHash[sender]?.score ?? 0)
		const verified = !!content.verified && await verifySlashProof(username, groupId, content, readEvents)
		const rawClaim = Number(content.claim ?? content.unverifiedClaim ?? (verified ? 0.35 : 0.2))
		const claim = Number.isFinite(rawClaim) ? rawClaim : 0.2
		const penalty = subjectiveSlashPenalty(claim, repSender, repMaxEff, verified)
		adjustNodeReputation(data, target, groupId, -penalty)
	})
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {object} content slash content
 * @param {(username: string, groupId: string) => Promise<object[]>} readEvents 读 DAG
 * @returns {Promise<boolean>} 是否找到 proof 对应事件
 */
async function verifySlashProof(username, groupId, content, readEvents) {
	const eventId = content?.proof?.eventId?.trim().toLowerCase()
	if (!eventId) return false
	const events = await readEvents(username, groupId)
	return events.some(e => e?.id === eventId)
}

/**
 * @param {string} username 用户
 * @param {string} targetPubKeyHash 目标
 * @param {Array<{ from?: string, to?: string }>} inviteEdges 邀请边
 * @returns {void}
 */
export function applyDecayCollusionAfterSlash(username, targetPubKeyHash, inviteEdges) {
	const t = targetPubKeyHash.trim().toLowerCase()
	const edges = inviteEdges ?? []
	const lambda = 0.07
	const delta = 0.62
	void mutateReputation(username, data => {
		let frontier = new Set([t])
		for (let hop = 1; hop <= 6; hop++) {
			const upstream = new Set()
			for (const edge of edges) {
				const from = String(edge?.from || '').trim().toLowerCase()
				const to = String(edge?.to || '').trim().toLowerCase()
				if (from && to && frontier.has(to)) upstream.add(from)
			}
			if (!upstream.size) break
			const dRep = lambda * delta ** hop
			for (const node of upstream) {
				const prev = Number(data.byNodeHash[node]?.score ?? 0)
				data.byNodeHash[node] = { score: clampReputationScore(prev - dRep) }
			}
			frontier = upstream
		}
	})
}

/**
 * @param {string} username 用户
 * @param {string} targetPubKeyHash 目标
 * @returns {void}
 */
export function applyReputationResetToScores(username, targetPubKeyHash) {
	const t = targetPubKeyHash.trim().toLowerCase()
	void mutateReputation(username, data => {
		data.byNodeHash[t] = { score: 0 }
	})
}

/**
 * @param {string} username 用户
 * @param {string} memberPubKeyHash 新成员
 * @param {string} [introducerPubKeyHash] 介绍者
 * @param {number} [repEdge] 边信任
 * @returns {void}
 */
export function seedMemberReputationFromIntroducer(username, memberPubKeyHash, introducerPubKeyHash, repEdge) {
	const memberKey = memberPubKeyHash.trim().toLowerCase()
	const introducerKey = introducerPubKeyHash?.trim().toLowerCase() || ''
	void mutateReputation(username, data => {
		if (data.byNodeHash[memberKey]) return
		const introducerReputation = introducerKey
			? Number(data.byNodeHash[introducerKey]?.score ?? 0)
			: 0
		data.byNodeHash[memberKey] = { score: seedReputationFromIntro(introducerReputation, repEdge) }
	})
}

/**
 * @param {string} username 用户
 * @param {string} nodeId 64 hex
 * @param {string} [groupId] 群 scope；有则返回该群 scope 分，否则全局
 * @returns {number} 信誉分
 */
export function pickNodeScore(username, nodeId, groupId = '') {
	const row = loadReputation(username).byNodeHash[nodeId]
	if (!row) return 0
	const gid = String(groupId || '').trim()
	if (gid && row.scopes?.[gid] != null) return Number(row.scopes[gid])
	return Number(row.score ?? 0)
}
