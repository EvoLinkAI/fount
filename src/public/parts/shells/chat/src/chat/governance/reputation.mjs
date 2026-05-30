/**
 * 【文件】governance/reputation.mjs
 * 【职责】群主观信誉 §9–10：中继/供块/恶意 want/拉取失败等加减分，持久化 reputation.json，并经 fed_volatile 广播 slash 告警。
 * 【原理】load/saveReputation 按 nodeId 记分；bumpReputationOnRelay 与 recordGossipAllUnknownWant 在 room/gossip 路径触发；chunk 存储成败挂钩联邦分块。applyVolatileSlashAlert 处理入站 reputation_slash_alert。
 * 【数据结构】ReputationFile { schema, byNodeId: {score}, wantUnknownHits[] }；slashAlertTtl 来自 groupSettings。
 * 【关联】federation room、gossip、chunks、volatile.mjs、scripts/p2p/reputation.mjs、want_ids.mjs。
 */
/**
 * 【文件】governance/reputation.mjs
 * 【职责】per-group 主观信誉分：want_ids 空批惩罚、供块/拉块加减分、computeRepMaxEff（§9 §10.4）。
 * 【原理】reputation.json 本地表；subjectiveSlashPenalty 钳制；seedReputationFromIntro 初值；与 peer_pool 联动 trusted。
 * 【数据结构】ReputationFile { schema, byNodeId: { score }, wantUnknownHits[] }。
 * 【关联】peerPool、chunk 存储失败 penalizeChunkStorageFailure；paths reputationPath。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import {
	clampReputationScore,
	computeRepMaxEff,
	seedReputationFromIntro,
	subjectiveSlashPenalty,
} from '../../../../../../../scripts/p2p/reputation.mjs'
import {
	RELAY_BUMP_DEDUPE_MS,
	relayBumpIsDuplicate,
} from '../../../../../../../scripts/p2p/reputation_relay_dedupe.mjs'
import {
	recordWantIdsBackoff,
	wantIdsPeerKey,
} from '../../../../../../../scripts/p2p/want_ids.mjs'
import { readJsonl } from '../dag/storage.mjs'
import { eventsPath, reputationPath } from '../lib/paths.mjs'

/** §9 默认：5 分钟内同一邻居「整批 want 本地全无」累计次数 */
const WANT_UNKNOWN_WINDOW_MS = 5 * 60 * 1000
const WANT_UNKNOWN_THRESHOLD = 3
/** 单次恶意惩罚（主观标量） */
const PENALTY_UNKNOWN_WANT = 0.12
/** 联邦入站超速 message 扣分 */
const PENALTY_MESSAGE_RATE = 0.15

/** federated_chunks：成功供块加分（§10.4） */
const CHUNK_STORE_REP_BUMP = 0.03
/** 拉取/解密失败扣分 */
const CHUNK_FETCH_FAIL_PENALTY = 0.08

/**
 * @typedef {{
 *   schema: number
 *   byNodeId: Record<string, { score: number }>
 *   wantUnknownHits: Array<{ peerNodeId: string, t: number }>
 *   relayBumpSeen: Array<{ peerNodeId: string, key: string, t: number }>
 * }} ReputationFile
 */

const MAX_RELAY_BUMP_SEEN = 2000

/**
 *
 */
export { relayBumpIsDuplicate } from '../../../../../../../scripts/p2p/reputation_relay_dedupe.mjs'

/**
 * @param {unknown} raw 磁盘 JSON
 * @returns {ReputationFile} 规范化后的信誉文件对象
 */
function normalizeRepFile(raw) {
	const file = raw || {}
	/** @type {Record<string, { score: number }>} */
	const byNodeId = { ...file.byNodeId || {} }
	for (const nodeId of Object.keys(byNodeId)) {
		const score = Number(byNodeId[nodeId]?.score)
		byNodeId[nodeId] = { score: clampReputationScore(Number.isFinite(score) ? score : 0) }
	}
	const wantUnknownHits = (file.wantUnknownHits || [])
		.filter(hit => hit?.peerNodeId && Number.isFinite(hit.t))
		.map(hit => ({ peerNodeId: String(hit.peerNodeId), t: Number(hit.t) }))
	const relayBumpSeen = (file.relayBumpSeen || [])
		.filter(hit => hit?.peerNodeId && hit?.key && Number.isFinite(hit.t))
		.map(hit => ({
			peerNodeId: String(hit.peerNodeId),
			key: String(hit.key),
			t: Number(hit.t),
		}))
	return { schema: 1, byNodeId, wantUnknownHits, relayBumpSeen }
}

/**
 * 读取群本地信誉文件；不存在时返回默认空表。
 * @param {string} username 用户名
 * @param {string} groupId 群 ID
 * @returns {Promise<ReputationFile>} 规范化后的信誉表对象
 */
export async function loadReputation(username, groupId) {
	const p = reputationPath(username, groupId)
	try {
		const text = await readFile(p, 'utf8')
		return normalizeRepFile(JSON.parse(text))
	}
	catch {
		return normalizeRepFile(null)
	}
}

/**
 * 写入群本地信誉文件。
 * @param {string} username 用户名
 * @param {string} groupId 群 ID
 * @param {ReputationFile} data 信誉表
 * @returns {Promise<void>}
 */
export async function saveReputation(username, groupId, data) {
	const p = reputationPath(username, groupId)
	await mkdir(dirname(p), { recursive: true })
	const clean = normalizeRepFile(data)
	const now = Date.now()
	clean.wantUnknownHits = clean.wantUnknownHits.filter(h => now - h.t <= WANT_UNKNOWN_WINDOW_MS)
	clean.relayBumpSeen = clean.relayBumpSeen.filter(h => now - h.t <= RELAY_BUMP_DEDUPE_MS)
	if (clean.relayBumpSeen.length > MAX_RELAY_BUMP_SEEN)
		clean.relayBumpSeen = clean.relayBumpSeen.slice(-MAX_RELAY_BUMP_SEEN)
	await writeFile(p, JSON.stringify(clean, null, '\t'), 'utf8')
}

/** 合法中继/应答微增信誉（§22.1）。 */
const RELAY_REP_BUMP = 0.02

/**
 * 成功为邻居转发或应答 DAG/gossip 时略增信誉（同 peer+dedupeKey 24h 内只计一次）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} peerNodeId 对端节点 id
 * @param {string} [dedupeKey] 贡献去重键
 * @returns {Promise<void>} 写入完成
 */
export async function bumpReputationOnRelay(username, groupId, peerNodeId, dedupeKey) {
	const id = String(peerNodeId || '').trim()
	if (!id) return
	const key = String(dedupeKey || `conn:${id}`).trim()
	const data = await loadReputation(username, groupId)
	const now = Date.now()
	data.relayBumpSeen = (data.relayBumpSeen || []).filter(h => now - h.t <= RELAY_BUMP_DEDUPE_MS)
	if (relayBumpIsDuplicate(data.relayBumpSeen, id, key, now)) return
	data.relayBumpSeen.push({ peerNodeId: id, key, t: now })
	const prev = Number(data.byNodeId[id]?.score ?? 0)
	data.byNodeId[id] = { score: clampReputationScore(prev + RELAY_REP_BUMP) }
	await saveReputation(username, groupId, data)
}

/**
 * 邻居整批 want 的 ID 在本节点均不存在时记录；窗口内达阈值则扣信誉（§9）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} peerNodeId 请求方节点 id
 * @returns {Promise<void>}
 */
export async function recordGossipAllUnknownWant(username, groupId, peerNodeId) {
	const now = Date.now()
	const data = await loadReputation(username, groupId)
	data.wantUnknownHits = data.wantUnknownHits.filter(h => now - h.t <= WANT_UNKNOWN_WINDOW_MS)
	data.wantUnknownHits.push({ peerNodeId, t: now })
	const recent = data.wantUnknownHits.filter(h => h.peerNodeId === peerNodeId)
	if (recent.length >= WANT_UNKNOWN_THRESHOLD) {
		const cur = data.byNodeId[peerNodeId]?.score ?? 0
		data.byNodeId[peerNodeId] = { score: clampReputationScore(cur - PENALTY_UNKNOWN_WANT) }
		data.wantUnknownHits = data.wantUnknownHits.filter(h => h.peerNodeId !== peerNodeId)
		recordWantIdsBackoff(wantIdsPeerKey(username, groupId, peerNodeId))
	}
	await saveReputation(username, groupId, data)
}

/**
 * 邻居发送超速 message 时降信誉。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} peerNodeId 对端 nodeId
 * @returns {Promise<void>}
 */
export async function recordMessageRateViolation(username, groupId, peerNodeId) {
	const id = String(peerNodeId || '').trim()
	if (!id) return
	const data = await loadReputation(username, groupId)
	const prev = Number(data.byNodeId[id]?.score ?? 0)
	data.byNodeId[id] = { score: clampReputationScore(prev - PENALTY_MESSAGE_RATE) }
	await saveReputation(username, groupId, data)
}

/**
 * 成功存储 federated chunk 后对存储责任方加分（§10.4）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} storagePeerKey 节点 id 或 pubKeyHash
 * @returns {Promise<void>}
 */
export async function bumpChunkStorageReputation(username, groupId, storagePeerKey) {
	const id = String(storagePeerKey || '').trim()
	if (!id) return
	const data = await loadReputation(username, groupId)
	const prev = Number(data.byNodeId[id]?.score ?? 0)
	data.byNodeId[id] = { score: clampReputationScore(prev + CHUNK_STORE_REP_BUMP) }
	await saveReputation(username, groupId, data)
}

/**
 * 分块拉取或解密失败时对责任方降信誉（§10.4）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} blamePeerKey 责任方
 * @returns {Promise<void>}
 */
export async function penalizeChunkStorageFailure(username, groupId, blamePeerKey) {
	const id = String(blamePeerKey || '').trim()
	if (!id) return
	const data = await loadReputation(username, groupId)
	const prev = Number(data.byNodeId[id]?.score ?? 0)
	data.byNodeId[id] = { score: clampReputationScore(prev - CHUNK_FETCH_FAIL_PENALTY) }
	await saveReputation(username, groupId, data)
}

/** 默认不可验证 Slash VOLATILE TTL（毫秒，§6.3 `slashAlertTtl`）。 */
const DEFAULT_SLASH_ALERT_TTL_MS = 86_400_000

/**
 * 从群设置解析不可验证 Slash 的联邦 TTL。
 * @param {object | null | undefined} groupSettings 物化群设置
 * @returns {number} 毫秒
 */
export function resolveSlashAlertTtlMs(groupSettings) {
	const n = Number(groupSettings?.slashAlertTtl)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SLASH_ALERT_TTL_MS
}

/**
 * 应用联邦 VOLATILE `reputation_slash_alert`（不入 DAG，§6.3）：仅作提示，不修改信誉分。
 * @param {string} username 本节点用户（replica 所有者）
 * @param {string} groupId 群 ID
 * @param {object} alert 载荷（含 targetPubKeyHash、sender、claim、expiresAt）
 * @returns {Promise<boolean>} 载荷合法且未过期为 true
 */
export async function applyVolatileSlashAlert(username, groupId, alert) {
	void username
	void groupId
	const expiresAt = Number(alert?.expiresAt)
	if (Number.isFinite(expiresAt) && Date.now() > expiresAt) return false
	const target = String(alert?.targetPubKeyHash || '').trim().toLowerCase()
	const sender = String(alert?.sender || '').trim().toLowerCase()
	return isHex64(target) && isHex64(sender)
}

/**
 * 本节点签发不可验证 Slash 提示，返回可供联邦中继的 VOLATILE 体（不扣分）。
 * @param {string} senderPubKeyHash 签发者 pubKeyHash（64 hex）
 * @param {string} groupId 群 ID
 * @param {{ targetPubKeyHash: string, claim?: number }} content Slash 内容
 * @param {object} [groupSettings] 群设置（TTL）
 * @returns {Promise<object>} `reputation_slash_alert` 载荷
 */
export async function buildAndApplyUnverifiedSlashAlert(senderPubKeyHash, groupId, content, groupSettings = {}) {
	void groupId
	const targetPubKeyHash = String(content.targetPubKeyHash || '').trim().toLowerCase()
	const claim = Number.isFinite(Number(content.claim)) ? Number(content.claim) : 0.2
	const sender = String(senderPubKeyHash || '').trim().toLowerCase()
	if (!isHex64(targetPubKeyHash) || !isHex64(sender))
		throw new Error('invalid slash alert sender or target')
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
 * 不可验证主观 Slash：对目标扣分 `|claim| * rep(sender) / rep_max_eff`（§0.1）；可验证类仅占位为固定权重。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {object} event `reputation_slash` DAG 事件
 * @returns {Promise<void>}
 */
export async function applySubjectiveSlashFromEvent(username, groupId, event) {
	if (event?.type !== 'reputation_slash') return
	const content = event.content || {}
	const target = String(content.targetPubKeyHash || '').trim().toLowerCase()
	const sender = String(event.sender || '').trim().toLowerCase()
	if (!isHex64(target) || !isHex64(sender)) return

	const data = await loadReputation(username, groupId)
	const repMaxEff = computeRepMaxEff(data)
	const repSender = Number(data.byNodeId[sender]?.score ?? 0)
	const verified = !!content.verified && await verifySlashProof(username, groupId, content)
	const rawClaim = Number(content.claim ?? content.unverifiedClaim ?? (verified ? 0.35 : 0.2))
	const claim = Number.isFinite(rawClaim) ? rawClaim : 0.2
	const penalty = subjectiveSlashPenalty(claim, repSender, repMaxEff, verified)
	const prev = Number(data.byNodeId[target]?.score ?? 0)
	data.byNodeId[target] = { score: clampReputationScore(prev - penalty) }
	await saveReputation(username, groupId, data)
}

/**
 * 可验证 Slash：载荷须含本地可见 DAG 中存在的 `proof.eventId`（§0.1 伪造证据无效）。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {object} content reputation_slash content
 * @returns {Promise<boolean>} 证据 id 是否存在于本地 DAG
 */
async function verifySlashProof(username, groupId, content) {
	const eventId = String(content?.proof?.eventId || '').trim().toLowerCase()
	if (!isHex64(eventId)) return false
	const events = await readJsonl(eventsPath(username, groupId))
	return events.some(e => e?.id === eventId)
}

/**
 * §0.3 衰减连坐：沿 `inviteEdges` 从被 slash 成员向上游 introducer 递减扣分。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {string} targetPubKeyHash 被惩罚成员公钥哈希
 * @param {Array<{ from?: string, to?: string }>} inviteEdges 邀请边
 * @returns {Promise<void>}
 */
export async function applyDecayCollusionAfterSlash(username, groupId, targetPubKeyHash, inviteEdges) {
	const t = String(targetPubKeyHash || '').trim().toLowerCase()
	if (!isHex64(t)) return
	const edges = Array.isArray(inviteEdges) ? inviteEdges : []
	const lambda = 0.07
	const delta = 0.62
	const data = await loadReputation(username, groupId)
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
			const prev = Number(data.byNodeId[node]?.score ?? 0)
			data.byNodeId[node] = { score: clampReputationScore(prev - dRep) }
		}
		frontier = upstream
	}
	await saveReputation(username, groupId, data)
}

/**
 * `reputation_reset` 后同步主观表：目标条目归零（§6.3 本地解封语义简化）。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {string} targetPubKeyHash 目标公钥哈希
 * @returns {Promise<void>}
 */
export async function applyReputationResetToScores(username, groupId, targetPubKeyHash) {
	const t = String(targetPubKeyHash || '').trim().toLowerCase()
	if (!isHex64(t)) return
	const data = await loadReputation(username, groupId)
	data.byNodeId[t] = { score: 0 }
	await saveReputation(username, groupId, data)
}

/**
 * §0.3：新成员首次写入主观信誉 `rep_local(intro) * reputationEdge` 再 clamp。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {string} memberPubKeyHash 新成员
 * @param {string} [introducerPubKeyHash] 介绍者
 * @param {number} [repEdge] 边信任，缺省 1
 * @returns {Promise<void>}
 */
export async function seedMemberReputationFromIntroducer(username, groupId, memberPubKeyHash, introducerPubKeyHash, repEdge) {
	const memberKey = String(memberPubKeyHash || '').trim().toLowerCase()
	if (!isHex64(memberKey)) return
	const introducerKey = String(introducerPubKeyHash || '').trim().toLowerCase()
	const data = await loadReputation(username, groupId)
	if (data.byNodeId[memberKey]) return
	const introducerReputation = isHex64(introducerKey)
		? Number(data.byNodeId[introducerKey]?.score ?? 0)
		: 0
	data.byNodeId[memberKey] = { score: seedReputationFromIntro(introducerReputation, repEdge) }
	await saveReputation(username, groupId, data)
}

