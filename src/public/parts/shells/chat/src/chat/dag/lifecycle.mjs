/**
 * 【文件】`dag/lifecycle.mjs` — 群 DAG 生命周期（创建/确保/拆除）。
 * 【职责】创世写入元数据、默认频道、群设置、默认角色与 `member_join`；合并 DAG tips；删除本机群副本数据。
 * 【原理】`createGroup` 顺序 append 多条创世事件后物化；`ensureGroup` 在 `events.jsonl` 缺失时建群；`mergeDagTips` 用多父 `dag_tip_merge` 汇合分叉；拆除时释放文件引用并清联邦/会话缓存。
 * 【数据结构】返回 `{ groupId, checkpoint, defaultChannelId }` 或 `{ groupId, created }`。
 * 【关联】`append.mjs`、`materialize.mjs`、`events/hlcPolicy.mjs`、`../federation/room.mjs`。
 */
import { randomUUID } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'

import { geti18nForUser } from '../../../../../../../scripts/i18n.mjs'
import { DEFAULT_STREAM_GENERATING_IDLE_MS } from '../../../../../../../scripts/p2p/constants.mjs'
import { sortedPrevEventIds } from '../../../../../../../scripts/p2p/dag/index.mjs'
import { computeDagTipIdsFromEvents } from '../../../../../../../scripts/p2p/governance_branch.mjs'
import { createDefaultRoles } from '../../../../../../../scripts/p2p/permissions.mjs'
import { syncEntityProfileFromPersona } from '../../profile/syncFromPersona.mjs'
import { DEFAULT_HLC_MAX_SKEW_MS } from '../events/hlcPolicy.mjs'
import { isGroupFederationActive } from '../federation/groupFederation.mjs'
import { DEFAULT_MQTT_APP_ID, mintMqttRoomSecret } from '../federation/mqttCredentials.mjs'
import { ensureFederationRoom, invalidateFederationRoomCache } from '../federation/room.mjs'
import { releaseFileStorageRefs } from '../files/groupFiles.mjs'
import { initGroupH } from '../gsh/store.mjs'
import { groupDir, eventsPath } from '../lib/paths.mjs'
import { getLocalNodeHash } from '../lib/replica.mjs'
import { safeRm } from '../lib/utils.mjs'
import { purgeGroupSession } from '../session/wsLifecycle.mjs'
import { dropGroupReplicaRegistration } from '../stream/groupWsRooms.mjs'

import { appendEvent } from './append.mjs'
import { getLocalSignerForNewGroup } from './localSigner.mjs'
import { getState } from './materialize.mjs'
import { readJsonl } from './storage.mjs'

/**
 * 将当前所有 DAG 叶合并为单条多父事件（§0 多父汇合）。
 * @param {string} username 用户
 * @param {string} groupId 群
 * @param {string} sender 成员键
 * @param {Uint8Array} [secretKey] 可选私钥种子
 * @returns {Promise<object>} 签名后事件
 */
export async function mergeDagTips(username, groupId, sender, secretKey) {
	const rows = await readJsonl(eventsPath(username, groupId))
	const tips = computeDagTipIdsFromEvents(rows)
	if (tips.length < 2) throw new Error('dag_tip_merge: fewer than 2 tips')
	return appendEvent(username, groupId, {
		type: 'dag_tip_merge',
		sender,
		timestamp: Date.now(),
		content: { mergedTipCount: tips.length },
		prev_event_ids: sortedPrevEventIds(tips),
	}, secretKey)
}

/**
 * 创建新群：写入创世 `group_meta_update`、默认频道与默认频道设置事件。
 * @param {string} username 用户名
 * @param {object} body 建群参数
 * @returns {Promise<{ groupId: string, checkpoint: object | null, defaultChannelId: string }>} 新群元数据
 */
export async function createGroup(username, body) {
	const groupId = body.groupId || randomUUID()
	await mkdir(groupDir(username, groupId), { recursive: true })
	const owner = String(body.ownerPubKeyHash || '').trim().toLowerCase()
	if (!owner) throw new Error('ownerPubKeyHash required')
	const memberJoinSecretKey = body.secretKey
	const genesisSecretKey = memberJoinSecretKey || (await getLocalSignerForNewGroup(username, groupId)).secretKey
	const genesisSender = owner

	await appendEvent(username, groupId, {
		type: 'group_meta_update',
		sender: genesisSender,
		timestamp: Date.now(),
		content: {
			name: body.name || await geti18nForUser(username, 'chat.group.defaults.groupMetaName'),
			description: body.description ?? '',
			...body.friendBinding ? { friendBinding: body.friendBinding } : {},
		},
	}, genesisSecretKey)

	const initialChannelId = body.defaultChannelId || 'default'
	await appendEvent(username, groupId, {
		type: 'channel_create',
		sender: genesisSender,
		timestamp: Date.now(),
		content: {
			channelId: initialChannelId,
			type: body.defaultChannelType || 'text',
			name: body.defaultChannelName || await geti18nForUser(username, 'chat.group.defaults.defaultChannelName'),
			syncScope: 'group',
		},
	}, genesisSecretKey)

	await appendEvent(username, groupId, {
		type: 'group_settings_update',
		sender: genesisSender,
		timestamp: Date.now(),
		content: {
			defaultChannelId: initialChannelId,
			streamGeneratingIdleMs: DEFAULT_STREAM_GENERATING_IDLE_MS,
			hlcMaxSkewMs: DEFAULT_HLC_MAX_SKEW_MS,
			streamingSfuWss: null,
			maxDagPayloadBytes: 262_144,
			maxPeers: 24,
			trustedPeerSlots: 8,
			explorePeerSlots: 4,
			gossipTtl: 2,
			wantIdsBudget: 16,
			batterySaver: false,
			event_retention_depth: 200_000,
			event_retention_ms: 365 * 24 * 3600 * 1000,
			message_content_retention_ms: 0,
			...body.enableGroupFederation ? {
				mqttAppId: DEFAULT_MQTT_APP_ID,
				mqttRoomSecret: mintMqttRoomSecret(),
				federationPartitionCount: 8,
				rtcConnectionBudgetMax: 32,
				rtcJoinRatePerMin: 12,
			} : {},
			autoChannelGc: true,
		},
	}, genesisSecretKey)

	for (const [roleId, roleDef] of Object.entries(createDefaultRoles()))
		await appendEvent(username, groupId, {
			type: 'role_create',
			sender: genesisSender,
			timestamp: Date.now(),
			content: {
				roleId,
				name: roleDef.name,
				color: roleDef.color,
				position: roleDef.position,
				permissions: roleDef.permissions,
				isDefault: roleDef.isDefault,
				isHoisted: roleDef.isHoisted,
			},
		}, genesisSecretKey)

	await appendEvent(username, groupId, {
		type: 'member_join',
		sender: owner,
		timestamp: Date.now(),
		content: {
			roles: ['founder'],
			homeNodeHash: getLocalNodeHash(username),
		},
	}, memberJoinSecretKey || genesisSecretKey)

	await syncEntityProfileFromPersona(username, groupId)

	await initGroupH(username, groupId)

	const { checkpoint, state } = await getState(username, groupId)
	try {
		const { invalidateKnownMemberIndex } = await import('../mailbox/memberIndex.mjs')
		invalidateKnownMemberIndex(username)
	}
	catch { /* ignore */ }
	return {
		groupId,
		checkpoint,
		defaultChannelId: state.groupSettings?.defaultChannelId ?? initialChannelId,
	}
}

/**
 * @param {string} username 用户名
 * @param {string} groupId 群组/会话 ID
 * @param {object} [options] 建群参数
 * @returns {Promise<{ groupId: string, created: boolean }>} 群 ID 与是否新建
 */
export async function ensureGroup(username, groupId, options = {}) {
	let out
	try {
		await access(eventsPath(username, groupId))
		out = { groupId, created: false }
	}
	catch {
		const { sender: ownerPubKeyHash, secretKey } = await getLocalSignerForNewGroup(username, groupId)
		await createGroup(username, {
			groupId,
			name: options.name || await geti18nForUser(username, 'chat.group.defaults.dmChatName'),
			description: options.description,
			defaultChannelName: options.defaultChannelName
				|| await geti18nForUser(username, 'chat.group.defaults.defaultChannelName'),
			ownerPubKeyHash,
			secretKey,
		})
		out = { groupId, created: true }
	}
	const { state } = await getState(username, groupId)
	if (isGroupFederationActive(state.groupSettings))
		void ensureFederationRoom(username, groupId, {
			channelId: options.defaultChannelId || 'default',
		}).catch(console.error)
	return out
}

/**
 * @param {string} username 用户名
 * @param {string} groupId 群组 ID
 * @returns {Promise<void>}
 */
export async function deleteGroupData(username, groupId) {
	await safeRm(groupDir(username, groupId), { recursive: true, force: true })
}

/**
 * 拆除本机群副本：释放文件引用、断开联邦、清内存并删除磁盘目录。
 * @param {string} username 用户名
 * @param {string} groupId 群 ID
 * @returns {Promise<void>}
 */
export async function removeLocalGroupReplica(username, groupId) {
	const { state } = await getState(username, groupId)
	for (const meta of Object.values(state.fileIndex || {}))
		if (meta && !meta.deleted) await releaseFileStorageRefs(username, groupId, meta)

	invalidateFederationRoomCache(username, groupId)
	purgeGroupSession(groupId)
	dropGroupReplicaRegistration(groupId)
	await deleteGroupData(username, groupId)
}
