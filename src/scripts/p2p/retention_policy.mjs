/**
 * DAG 事件保留窗口纯函数（无 I/O）。
 */

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
 * 计算保留窗口起始下标。
 * @param {string[]} order 拓扑序
 * @param {Map<string, object>} byId 事件表
 * @param {{ maxDepth: number, cutoffWall: number, checkpointTipId?: string }} opts 参数
 * @returns {number} `order` 切片起点
 */
export function retentionStartIndex(order, byId, opts) {
	const { maxDepth, cutoffWall, checkpointTipId } = opts
	let startIdx = 0
	for (let index = 0; index < order.length; index++) {
		const ev = byId.get(order[index])
		const wall = Number(ev?.hlc?.wall ?? 0)
		if (wall >= cutoffWall) {
			startIdx = index
			break
		}
	}
	if (checkpointTipId) {
		const tipIdx = order.indexOf(checkpointTipId)
		if (tipIdx >= 0) startIdx = Math.min(startIdx, tipIdx)
	}
	startIdx = Math.min(startIdx, permissionAnchorStartIndex(order, byId))
	if (order.length - startIdx > maxDepth)
		startIdx = Math.max(startIdx, order.length - maxDepth)
	return startIdx
}
