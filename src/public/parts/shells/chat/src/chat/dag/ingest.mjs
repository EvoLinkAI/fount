/**
 * 【文件】`dag/ingest.mjs` — 入站事件鉴权（本地与联邦共用）。
 * 【职责】在 append/远程入库前校验 join 策略、消息索引、权限矩阵、session 形状与 `dag_tip_merge` 前驱合法性。
 * 【原理】先物化当前群状态再判权；联邦路径要求 ACL 快照就绪且 sender 为 pubKeyHash；消息变更类事件走 `assertEventPermission`；`dag_tip_merge` 要求 `prev_event_ids` 覆盖全部当前 DAG tips。
 * 【数据结构】入参为 DAG 事件对象；`opts.source` 为 `'local' | 'federation'`。
 * 【关联】`authorizeEvent.mjs`、`materialize.mjs`、`sessionEventValidate.mjs`、`../federation/acl.mjs`。
 */
import { sortedPrevEventIds } from '../../../../../../../scripts/p2p/dag/index.mjs'
import { computeDagTipIdsFromEvents } from '../../../../../../../scripts/p2p/governance_branch.mjs'
import { assertHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { resolveActiveMemberKey } from '../../group/access.mjs'
import {
	hasMaterializedAclSnapshot,
	isAuthzGatedEventType,
	shouldDeferFederatedRelay,
} from '../federation/acl.mjs'
import { isPubKeyHashBlocked } from '../governance/blocklist.mjs'
import { validateJoinPolicy } from '../governance/joinPolicy.mjs'
import { eventsPath } from '../lib/paths.mjs'

import { assertEventPermission } from './authorizeEvent.mjs'
import { getState } from './materialize.mjs'
import { validateSessionEventContent } from './sessionEventValidate.mjs'
import { readJsonl } from './storage.mjs'
import { PUB_KEY_HASH_HEX } from './validator.mjs'

/**
 * @param {unknown} ref content_ref 对象
 */
function validateContentRefPayload(ref) {
	assertHex64(ref?.contentHash, 'content_ref.contentHash')
	const algorithm = ref?.alg?.trim()
	const byteLength = Number(ref?.byteLength)
	const storageLocator = ref?.storageLocator?.trim()
	if (!algorithm || !Number.isFinite(byteLength) || byteLength < 0 || !storageLocator)
		throw new Error('content_ref requires alg, byteLength, storageLocator')
}

const MESSAGE_MUTATION_TYPES = new Set(['message_edit', 'message_delete', 'message_feedback'])

/**
 * @param {object} state 物化群状态
 * @param {string} sender 事件 sender
 * @param {string} replicaUsername replica 所有者
 * @returns {string | null} pubKeyHash
 */
function resolveSenderPubKeyHash(state, sender, replicaUsername) {
	const direct = String(sender || '').trim()
	if (PUB_KEY_HASH_HEX.test(direct)) return direct.toLowerCase()
	const memberKey = resolveActiveMemberKey(state, sender) || resolveActiveMemberKey(state, replicaUsername)
	const hash = state.members[memberKey]?.pubKeyHash?.trim().toLowerCase() || ''
	return PUB_KEY_HASH_HEX.test(hash) ? hash : null
}

/**
 * 统一入站鉴权：joinPolicy、消息索引、权限矩阵（本地 append 与联邦落盘共用）。
 * @param {string} replicaUsername replica 所有者
 * @param {string} groupId 群 ID
 * @param {object} event 待校验事件
 * @param {{ source?: 'local' | 'federation' }} [opts] 入站来源（联邦路径要求 pubKeyHash sender）
 * @returns {Promise<void>}
 */
export async function validateIngestAuthz(replicaUsername, groupId, event, opts = {}) {
	const { state } = await getState(replicaUsername, groupId)

	if (opts.source === 'federation') {
		const type = event?.type
		if (!hasMaterializedAclSnapshot(state)
			&& isAuthzGatedEventType(type)
			&& type !== 'member_join')
			throw new Error('federated event dropped: no ACL snapshot')
		if (shouldDeferFederatedRelay(state, event))
			return
	}

	if (String(event.type || '').startsWith('session_')) {
		validateSessionEventContent(event)
		return
	}

	if (event.type === 'member_join')
		validateJoinPolicy(state, event, replicaUsername)

	if (event.type === 'message' && event.content?.content_ref)
		validateContentRefPayload(event.content.content_ref)

	if (MESSAGE_MUTATION_TYPES.has(event.type)) {
		const targetId = assertHex64(event.content?.targetId, 'targetId')
		const senderHash = resolveSenderPubKeyHash(state, event.sender, replicaUsername)
		if (!senderHash) throw new Error(`${event.type} requires pubKeyHash sender`)
		assertEventPermission(state, event, senderHash)
		return
	}

	if (event.type === 'reputation_reset') {
		const targetPubKeyHash = event.content?.targetPubKeyHash?.trim().toLowerCase() || ''
		if (targetPubKeyHash && isPubKeyHashBlocked(replicaUsername, targetPubKeyHash))
			throw new Error('reputation_reset ignored for locally blocked target')
	}

	if (event.type === 'dag_tip_merge') {
		const rows = await readJsonl(eventsPath(replicaUsername, groupId))
		const tips = computeDagTipIdsFromEvents(rows)
		if (tips.length < 2) throw new Error('dag_tip_merge: no fork')
		const expected = sortedPrevEventIds(tips)
		const got = sortedPrevEventIds(event.prev_event_ids)
		if (expected.length !== got.length || expected.some((id, index) => id !== got[index]))
			throw new Error('dag_tip_merge: prev_event_ids must list all current DAG tips')
	}

	const rawSender = String(event.sender || '').trim()
	if (!PUB_KEY_HASH_HEX.test(rawSender)) {
		if (opts.source === 'federation')
			throw new Error('federated events require pubKeyHash sender')
		return
	}

	const activeCount = Object.values(state.members || {}).filter(member => member?.status === 'active').length
	if (activeCount === 0 && new Set([
		'group_meta_update', 'channel_create', 'group_settings_update',
		'role_create', 'member_join',
	]).has(event.type)) return

	const senderHash = resolveSenderPubKeyHash(state, event.sender, replicaUsername)
	if (!senderHash) throw new Error('requires pubKeyHash sender')
	assertEventPermission(state, event, senderHash)
}
