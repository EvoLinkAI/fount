/** 主观信誉标量运算（§0.3、§0.1）；持久化由 chat shell 的 `reputation.mjs` 负责。 */

/**
 *
 */
export const REP_MIN = -1
/**
 *
 */
export const REP_MAX = 1
/** §0.1：`rep_max_eff = max(已链邻居最大信誉, ε)` */
export const REP_MAX_EFF_EPS = 1e-12

/**
 * @param {number} x 任意标量
 * @returns {number} clamp 到 [-1, 1]
 */
export function clampReputationScore(x) {
	return Math.min(REP_MAX, Math.max(REP_MIN, x))
}

/**
 * @param {{ byNodeId?: Record<string, { score?: number }> }} data 信誉表
 * @returns {number} `max(已链邻居最大信誉, ε)`（§0.1 `rep_max_eff`）
 */
export function computeRepMaxEff(data) {
	let m = /** @type {number | null} */ null
	for (const k of Object.keys(data.byNodeId || {})) {
		const s = Number(data.byNodeId[k]?.score)
		if (Number.isFinite(s)) m = m === null ? s : Math.max(m, s)
	}
	const repMax = m === null ? 0 : clampReputationScore(m)
	return Math.max(repMax, REP_MAX_EFF_EPS)
}

/**
 * 不可验证 Slash 落地扣分（§0.1）。
 * @param {number} claim 主张强度
 * @param {number} repSender 发送方信誉
 * @param {number} repMaxEff 分母
 * @param {boolean} [verified] 是否可验证
 * @returns {number} 对目标的扣分幅度（正数）
 */
export function subjectiveSlashPenalty(claim, repSender, repMaxEff, verified = false) {
	const c = Number.isFinite(claim) ? claim : 0.2
	const effective = (c * repSender) / repMaxEff
	return verified ? Math.abs(c) * 0.5 : Math.abs(effective)
}

/**
 * §0.3 初值：`clamp(rep_local(intro) * reputationEdge)`。
 * @param {number} introRep 介绍者信誉
 * @param {number} [repEdge] 边信任
 * @returns {number} 新成员初值
 */
export function seedReputationFromIntro(introRep, repEdge = 1) {
	const edge = typeof repEdge === 'number' && Number.isFinite(repEdge) ? clampReputationScore(repEdge) : 1
	return clampReputationScore(introRep * edge)
}
