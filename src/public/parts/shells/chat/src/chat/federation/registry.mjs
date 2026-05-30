/**
 * 【文件】federation/registry.mjs
 * 【职责】进程内联邦运行时注册表：Trystero 房间实例缓存、join 防重入、tip/gossip/频道历史等待槽，以及群→当前 join 用户的 owner 映射。
 * 【原理】federationRooms 以 username\0groupId 为键缓存 FederationSlot；inflight 合并并发 join；pendingTipExchanges / pendingGossipRequests / pendingChannelHistory 支撑异步 RPC 式等待。配置或房间名变更时递增 rebindGeneration 使进行中的 join 作废。
 * 【数据结构】Map 键多为 username\0groupId；groupFederationOwner: groupId→username；pending 表项含 collected Set、timer、resolve 回调。
 * 【关联】config.mjs、room.mjs、index.mjs、gossip.mjs、channelHistory.mjs、volatile.mjs；EVENT_ID_HEX 再导出给 wireSchemas。
 */
import { EVENT_ID_HEX } from '../../../../../../../scripts/p2p/dag/index.mjs'

/**
 * DAG 事件 ID 的 64 位小写 hex 正则（自 `p2p/dag` 再导出）。
 */
export { EVENT_ID_HEX }

/** @type {Map<string, Promise<object | null>>} */
export const federationRoomInflight = new Map()

/** @type {Map<string, object | null>} */
export const federationRooms = new Map()

/** @type {Map<string, number>} */
export const federationRoomRebindGeneration = new Map()

/** 群 ID → 已 join 联邦房间的用户名 */
/** @type {Map<string, string>} */
export const groupFederationOwner = new Map()

/** @type {Map<string, { collected: Set<string>, timer: ReturnType<typeof setTimeout>, resolve: () => void }>} */
export const pendingTipExchanges = new Map()

/** @type {Map<string, Array<{ resolve: () => void, timer: ReturnType<typeof setTimeout> }>>} */
export const pendingGossipRequests = new Map()

/** @type {Map<string, { resolve: (rows: object[]) => void, timer: ReturnType<typeof setTimeout> }>} */
export const pendingChannelHistory = new Map()

/**
 * @param {string} username 用户名
 * @param {string} groupId 群 ID
 * @returns {string} `username` 与 `groupId` 拼接的 Map 键
 */
export function federationRoomKey(username, groupId) {
	return `${username}\0${groupId}`
}

/**
 * @param {string} username 用户名
 * @param {string} groupId 群 ID
 * @param {string} [partitionId] 分区 id（如 sync、ch-03）
 * @returns {string} 分区房间 Map 键
 */
export function federationPartitionRoomKey(username, groupId, partitionId = 'sync') {
	return `${username}\0${groupId}\0${partitionId || 'sync'}`
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {string} tip 交换 pending 表键
 */
export function tipExchangeKey(username, groupId) {
	return `${username}\0${groupId}`
}
