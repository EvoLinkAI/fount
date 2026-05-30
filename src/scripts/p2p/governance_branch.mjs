import { sortedPrevEventIds } from './dag/index.mjs'
import { GOVERNANCE_AUTHZ_TYPES } from './event_types.mjs'

/**
 * 计算 DAG 叶事件 id。
 * @param {Array<{ id: string, prev_event_ids?: unknown }>} events 事件列表
 * @returns {string[]} 叶 id 列表
 */
export function computeDagTipIdsFromEvents(events) {
	if (!events.length) return []
	const referenced = new Set()
	for (const event of events)
		for (const parentId of sortedPrevEventIds(event.prev_event_ids))
			referenced.add(parentId)

	const tips = []
	for (const event of events)
		if (event.id && !referenced.has(event.id)) tips.push(event.id)
	return tips
}

/**
 * 从 tip 沿父指针闭包祖先 id。
 * @param {string} tipId 叶事件 id
 * @param {Map<string, { id: string, prev_event_ids?: unknown }>} byId id→事件
 * @returns {Set<string>} 祖先 id 集
 */
export function ancestorClosureFromTip(tipId, byId) {
	const out = new Set()
	const stack = [tipId]
	while (stack.length) {
		const id = stack.pop()
		if (!id || out.has(id)) continue
		out.add(id)
		const event = byId.get(id)
		if (!event) continue
		for (const parentId of sortedPrevEventIds(event.prev_event_ids))
			if (byId.has(parentId)) stack.push(parentId)
	}
	return out
}

/**
 * @param {string} tipId 叶 id
 * @param {Map<string, object>} byId id→事件
 * @param {Record<string, number>} reputationBySender 发送方主观信誉
 * @returns {number} 该叶上治理事件信誉加权和
 */
function governanceAuthzScoreForTip(tipId, byId, reputationBySender) {
	let score = 0
	for (const eventId of ancestorClosureFromTip(tipId, byId)) {
		const event = byId.get(eventId)
		if (!event || !GOVERNANCE_AUTHZ_TYPES.has(event.type)) continue
		const sender = String(event.sender).trim().toLowerCase()
		if (sender) score += Number(reputationBySender[sender] ?? 0)
	}
	return score
}

/**
 * 纯客观选支：仅统计治理事件数量，同分按 tipId 字典序（不读本地信誉）。
 * @param {string[]} tips 当前叶 id 列表
 * @param {Map<string, object>} byId id→事件
 * @returns {string | null} 选定 tip
 */
export function selectConsensusBranchTip(tips, byId) {
	if (!tips.length) return null
	if (tips.length === 1) return tips[0]
	let best = tips[0]
	let bestScore = -Infinity
	for (const tip of tips) {
		let score = 0
		for (const eventId of ancestorClosureFromTip(tip, byId)) {
			const event = byId.get(eventId)
			if (event && GOVERNANCE_AUTHZ_TYPES.has(event.type)) score++
		}
		if (score > bestScore || (score === bestScore && tip > best)) {
			bestScore = score
			best = tip
		}
	}
	return best
}

/**
 * 主观选支（仅 UI 预览 `localViewBranchTip`；checkpoint/联邦/ACL 必须用 consensus）。
 * @param {string[]} tips 当前叶 id 列表
 * @param {Map<string, object>} byId id→事件
 * @param {Record<string, number>} [reputationBySender] 发送方主观信誉
 * @param {string | null} [preferredTipId] 用户显式选支
 * @returns {string | null} 选定 tip
 */
export function selectAuthzBranchTip(tips, byId, reputationBySender = {}, preferredTipId = null) {
	if (!tips.length) return null
	if (preferredTipId && tips.includes(preferredTipId)) return preferredTipId
	if (tips.length === 1) return tips[0]

	let best = tips[0]
	let bestScore = -Infinity
	for (const tip of tips) {
		const score = governanceAuthzScoreForTip(tip, byId, reputationBySender)
		if (score > bestScore || (score === bestScore && tip > best)) {
			bestScore = score
			best = tip
		}
	}
	return best
}

/**
 * 为每个 DAG 叶计算治理事件信誉加权和（§8 选支可视化）。
 * @param {string[]} tips 叶 id 列表
 * @param {Map<string, object>} byId id→事件
 * @param {Record<string, number>} [reputationBySender] 发送方主观信誉
 * @returns {Record<string, number>} tipId → 分数
 */
export function computeTipAuthzScores(tips, byId, reputationBySender = {}) {
	/** @type {Record<string, number>} */
	const out = {}
	for (const tip of tips)
		out[tip] = governanceAuthzScoreForTip(tip, byId, reputationBySender)
	return out
}

/**
 * 为每个 DAG 叶计算客观治理计数分（用于共识分支可视化）。
 * @param {string[]} tips 叶 id 列表
 * @param {Map<string, object>} byId id→事件
 * @returns {Record<string, number>} tipId → 客观分
 */
export function computeTipConsensusScores(tips, byId) {
	/** @type {Record<string, number>} */
	const out = {}
	for (const tip of tips) {
		let score = 0
		for (const eventId of ancestorClosureFromTip(tip, byId)) {
			const event = byId.get(eventId)
			if (event && GOVERNANCE_AUTHZ_TYPES.has(event.type)) score++
		}
		out[tip] = score
	}
	return out
}

/**
 * 规范拓扑序中属于选定分支的事件 id。
 * @param {string[]} topologicalOrder 拓扑序 id 列表
 * @param {Map<string, object>} byId id→事件
 * @param {string | null} branchTipId 分支尖
 * @returns {string[]} 可折叠的 id 子序列
 */
export function authzFoldOrderIds(topologicalOrder, byId, branchTipId) {
	if (!branchTipId) return topologicalOrder
	const allowed = ancestorClosureFromTip(branchTipId, byId)
	return topologicalOrder.filter(id => allowed.has(id))
}

/**
 * 是否存在未合并的治理分叉。
 * @param {string[]} tips DAG 叶列表
 * @param {string | null} branchTipId 当前权限分支尖
 * @returns {boolean} 多叶且已选支时为 true
 */
export function hasGovernanceFork(tips, branchTipId) {
	return tips.length > 1 && !!branchTipId
}
