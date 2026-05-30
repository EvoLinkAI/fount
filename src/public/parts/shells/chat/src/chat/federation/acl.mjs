/**
 * 【文件】federation/acl.mjs
 * 【职责】联邦中继与本地落盘的 ACL 门控：区分「可写入 events.jsonl」「可立即中继」「应暂缓入 pending_relay」三类决策。
 * 【原理】授权类事件类型在物化 members 快照为空时：member_join 可落盘，其余 gated 类型拒绝；有快照则 checkEventPermission。batterySaver 且无快照时拒绝中继 gated 事件。shouldDeferFederatedRelay 在快照未就绪时把 gated 事件排队而非丢弃。
 * 【数据结构】event：{ type, sender }；state：物化群状态含 members、groupSettings.batterySaver。
 * 【关联】pendingRelay.mjs、index.mjs publishSignedEventToFederation、room ingest；dag/authorizeEvent.mjs、scripts/p2p/event_types.mjs。
 */
import { FEDERATION_ACL_GATED_EVENT_TYPES } from '../../../../../../../scripts/p2p/event_types.mjs'
import { checkEventPermission } from '../dag/authorizeEvent.mjs'
import { PUB_KEY_HASH_HEX } from '../dag/validator.mjs'

/**
 * 事件类型是否需 ACL 门控。
 * @param {string} type DAG 类型
 * @returns {boolean} 需要门控则为 true
 */
export function isAuthzGatedEventType(type) {
	return FEDERATION_ACL_GATED_EVENT_TYPES.has(type)
}

/**
 * 是否已有可求值的物化成员快照。
 * @param {object | null | undefined} state 物化群状态
 * @returns {boolean} 至少一名 active 成员则为 true
 */
export function hasMaterializedAclSnapshot(state) {
	return Object.values(state?.members || {}).some(member => member.status === 'active')
}

/**
 * 无物化 ACL 时仅暂缓中继，仍允许本地落盘（§2.1）。
 * @param {object | null | undefined} state 物化群状态
 * @param {{ type?: string }} event DAG 事件
 * @returns {boolean} 应入 pending_relay 队列则为 true
 */
export function shouldDeferFederatedRelay(state, event) {
	return isAuthzGatedEventType(event?.type) && !hasMaterializedAclSnapshot(state)
}

/**
 * 是否允许写入本节点 `events.jsonl`。
 * @param {object | null | undefined} state 物化群状态
 * @param {{ type?: string, sender?: string }} event DAG 事件
 * @returns {boolean} 允许落盘则为 true
 */
export function canAcceptFederatedEvent(state, event) {
	const type = event?.type
	if (!hasMaterializedAclSnapshot(state))
		if (isAuthzGatedEventType(type) && type !== 'member_join') return false

	if (shouldDeferFederatedRelay(state, event)) return true
	return canRelayFederatedEvent(state, event)
}

/**
 * 是否可立即向邻居中继（否则入 `pending_relay.jsonl`）。
 * @param {object | null | undefined} state 物化群状态
 * @param {{ type?: string, sender?: string }} event DAG 事件
 * @returns {boolean} 可立即中继则为 true
 */
export function canRelayFederatedEventNow(state, event) {
	if (shouldDeferFederatedRelay(state, event)) return false
	return canRelayFederatedEvent(state, event)
}

/**
 * 低功耗 / 无物化快照时：授权类事件拒绝权限门控路径；有快照则按权限门控（§2.1）。
 * @param {object | null | undefined} state 物化群状态
 * @param {{ type?: string, sender?: string }} event DAG 事件
 * @returns {boolean} 通过权限检查则为 true
 */
export function canRelayFederatedEvent(state, event) {
	const type = event?.type
	if (!type || !isAuthzGatedEventType(type)) return true
	if (state?.groupSettings?.batterySaver && !hasMaterializedAclSnapshot(state))
		return false
	if (!hasMaterializedAclSnapshot(state)) return false

	const sender = String(event.sender || '').trim().toLowerCase()
	if (!PUB_KEY_HASH_HEX.test(sender)) return false

	return checkEventPermission(state, event, sender).ok
}
