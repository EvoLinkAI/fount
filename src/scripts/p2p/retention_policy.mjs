import {
	ancestorClosureFromTip,
	authzFoldOrderIds,
	descendantClosureFromTip,
} from './governance_branch.mjs'

/** 裁剪时不得早于最早一条权限锚点事件（§7.1）。 */
export const PERMISSION_ANCHOR_TYPES = new Set([
	'member_join',
	'member_leave',
	'member_kick',
	'member_ban',
	'member_unban',
	'role_create',
	'role_update',
	'role_delete',
	'role_assign',
	'role_revoke',
	'reputation_slash',
	'reputation_reset',
	'key_rotate',
	'peer_invite',
	'channel_permissions_update',
	'channel_key_rotate',
	'channel_key_rotate_batch',
	'state_summary',
	'group_settings_update',
	'group_meta_update',
	'dag_tip_merge',
])

/**
 * @param {string[]} order 拓扑序 id 列表
 * @param {Map<string, object>} byId id → 事件
 * @returns {number} 最早须保留的事件下标
 */
export function permissionAnchorStartIndex(order, byId) {
	let anchor = order.length
	for (let index = order.length - 1; index >= 0; index--) {
		const ev = byId.get(order[index])
		if (ev && PERMISSION_ANCHOR_TYPES.has(ev.type)) anchor = index
	}
	return anchor
}

/**
 * 在共识分支上计算须保留的事件 id（连通子图，不用拓扑下标切片）。
 * @param {string[]} order 规范拓扑序
 * @param {Map<string, object>} byId id → 事件
 * @param {object} opts 保留策略
 * @param {number} opts.maxDepth 分支上最大事件深度
 * @param {number} opts.cutoffWall 最早保留的 HLC wall
 * @param {Set<string>} opts.anchorTypes 权限锚点事件类型
 * @param {string | null} [opts.checkpointTipId] checkpoint 尖
 * @param {string | null} [opts.branchTipId] 共识分支尖
 * @returns {Set<string>} 保留 id
 */
export function computeRetentionKeepIds(order, byId, opts) {
	const { maxDepth, cutoffWall, anchorTypes, checkpointTipId, branchTipId } = opts
	const branchOrder = authzFoldOrderIds(order, byId, branchTipId)
	const branchSet = new Set(branchOrder)
	if (!branchSet.size) return new Set()

	/** @type {Set<string>} */
	const keep = new Set()

	/**
	 *
	 * @param eventId
	 */
	/**
	 * @param {string} eventId 分支上某事件 id
	 */
	const addAncestorsOnBranch = eventId => {
		for (const id of ancestorClosureFromTip(eventId, byId))
			if (branchSet.has(id)) keep.add(id)
	}

	if (checkpointTipId && branchSet.has(checkpointTipId)) 
		for (const id of descendantClosureFromTip(checkpointTipId, byId))
			if (branchSet.has(id)) keep.add(id)
	

	for (let index = branchOrder.length - 1; index >= 0; index--) {
		const ev = byId.get(branchOrder[index])
		if (ev && anchorTypes.has(ev.type)) {
			addAncestorsOnBranch(branchOrder[index])
			break
		}
	}

	for (const id of branchOrder) {
		const ev = byId.get(id)
		const wall = Number(ev?.hlc?.wall ?? 0)
		if (wall >= cutoffWall) addAncestorsOnBranch(id)
	}

	if (branchOrder.length > maxDepth) 
		for (const id of branchOrder.slice(-maxDepth))
			addAncestorsOnBranch(id)
	

	if (!keep.size)
		for (const id of branchOrder) keep.add(id)

	return keep
}

/**
 * 计算保留窗口起始下标（兼容旧调用；基于 `computeRetentionKeepIds`）。
 * @param {string[]} order 拓扑序
 * @param {Map<string, object>} byId 事件表
 * @param {{ maxDepth: number, cutoffWall: number, checkpointTipId?: string, branchTipId?: string }} opts 参数
 * @returns {number} `order` 切片起点
 */
export function retentionStartIndex(order, byId, opts) {
	const keep = computeRetentionKeepIds(order, byId, {
		maxDepth: opts.maxDepth,
		cutoffWall: opts.cutoffWall,
		anchorTypes: PERMISSION_ANCHOR_TYPES,
		checkpointTipId: opts.checkpointTipId,
		branchTipId: opts.branchTipId,
	})
	for (let index = 0; index < order.length; index++)
		if (keep.has(order[index])) return index
	return order.length
}
