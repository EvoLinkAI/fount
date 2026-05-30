import { MEMBERS_PAGE_SIZE } from './constants.mjs'
import { merkleRoot } from './dag/index.mjs'
import { isHex64 } from './hexIds.mjs'
import { sanitizeIceServersForSettings } from './ice_servers.mjs'
import { calculateMemberPermissions, createDefaultRoles, PERMISSIONS } from './permissions.mjs'

/**
 * 刷新 `membersRoot`（活跃成员 Merkle）与 `membersPagesCount`（§7.2）。
 * @param {object} state 物化状态
 * @returns {void}
 */
function refreshMembersDigest(state) {
	const activeKeys = Object.entries(state.members || {})
		.filter(([, member]) => member?.status === 'active')
		.map(([memberKey]) => String(memberKey).trim().toLowerCase())
		.filter(isHex64)
		.sort()
	state.membersRoot = activeKeys.length ? merkleRoot(activeKeys) : null
	state.membersPagesCount = Math.max(1, Math.ceil(activeKeys.length / MEMBERS_PAGE_SIZE))
}

/**
 * 将介绍人给出的信誉边值限制在 [-1, 1]。
 * @param {unknown} value 事件中的原始数值
 * @returns {number} 限制后的值；无效输入时为 1
 */
function clampRepEdge(value) {
	const number = Number(value)
	if (!Number.isFinite(number)) return 1
	return Math.max(-1, Math.min(1, number))
}

/**
 * @param {object} state 物化状态
 * @param {object} event DAG 事件
 * @param {'kick' | 'rotate'} rotationType GSH 轮换原因
 * @param {Record<string, unknown>} [extra] 附加字段（如被踢成员）
 * @returns {void}
 */
function recordGshRotation(state, event, rotationType, extra = {}) {
	const generation = event.content?.key_generation
	const nonce = event.content?.new_H_nonce
	if (!Number.isFinite(generation) || !nonce) return
	state.gshRotations.push({
		eventId: event.id,
		generation,
		nonce,
		type: rotationType,
		...extra,
	})
}

/** §7.2 默认群设置（`defaultChannelId` 由建群时单独填入）。 */
export const DEFAULT_GROUP_SETTINGS = {
	joinPolicy: 'invite-only',
	powDifficulty: 4,
	fileSizeLimit: 10 * 1024 * 1024,
	fileQuotaBytes: 2 * 1024 * 1024 * 1024,
	fileUploadPolicy: 'all_members',
	fileReplicationFactor: 2,
	lateMessageFreezeMs: 30_000,
	streamGeneratingIdleMs: 150_000,
	hlcMaxSkewMs: 3_600_000,
	streamingSfuWss: null,
	maxDagPayloadBytes: 262_144,
	maxPeers: 24,
	trustedPeerSlots: 8,
	explorePeerSlots: 4,
	gossipTtl: 2,
	wantIdsBudget: 16,
	/** 静态 MQTT 频道分区数（含 sync 逻辑分区，至少 2） */
	federationPartitionCount: 8,
	rtcConnectionBudgetMax: 32,
	rtcJoinRatePerMin: 12,
	slashAlertTtl: 86_400_000,
	batterySaver: false,
	autoReplyFrequency: 0,
	event_retention_depth: 200_000,
	event_retention_ms: 365 * 24 * 3600 * 1000,
	/** 0 = 不自动删除消息正文；>0 时按毫秒裁 `messages/*.jsonl` */
	message_content_retention_ms: 0,
	compactTriggerEventDepth: 100_000,
	messageRateLimitPerMin: 10,
	messageRateLimitWindowMs: 60_000,
	iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
	/** 是否在联邦发现 gossip 中公开此群（不含 mqtt 口令） */
	discoveryPublic: false,
	discoveryTitle: null,
	discoveryBlurb: null,
}

/**
 * @param {unknown} rawMo checkpoint `messageOverlay`
 * @returns {[string, Map<string, string>][]} ballotId → 选民 Map 条目
 */
function votesEntriesFromOverlay(rawMo) {
	return Object.entries(rawMo.votes)
		.filter(([ballotId]) => !!ballotId)
		.map(([ballotId, voters]) => [ballotId, new Map(Object.entries(voters))])
}

/**
 * @param {Map<string, Map<string, string>>} votesMap 物化 overlay.votes
 * @returns {Record<string, Record<string, string>>} JSON 可序列化形状
 */
export function serializeVotesOverlay(votesMap) {
	const out = {}
	for (const [ballotId, voters] of votesMap)
		out[ballotId] = Object.fromEntries(voters)
	return out
}

/**
 * @param {Map<string, Set<string>>} reactionsMap 物化 overlay.reactions
 * @returns {Record<string, string[]>} JSON 可序列化形状
 */
export function serializeReactionsOverlay(reactionsMap) {
	const out = {}
	for (const [key, voters] of reactionsMap)
		out[key] = [...voters]
	return out
}

/**
 * @param {unknown} rawMo checkpoint `messageOverlay`
 * @returns {[string, Set<string>][]} `"targetId:emoji" → 选民 Set` 条目
 */
function reactionsEntriesFromOverlay(rawMo) {
	return Object.entries(rawMo.reactions)
		.filter(([key]) => !!key)
		.map(([key, voters]) => [key, new Set(voters.map(voter => String(voter).trim().toLowerCase()).filter(isHex64))])
}

/**
 * @returns {object} 空消息 overlay（Set/Map）
 */
function emptyMessageOverlay() {
	return {
		deletedIds: new Set(),
		editHistory: new Map(),
		reactions: new Map(),
		pins: new Map(),
		fileIndex: new Map(),
		/** ballotEventId -> Map<voterKey, choice> */
		votes: new Map(),
	}
}

/**
 * 空 AI 会话配置（角色/世界/人格/插件绑定，由 session_* DAG 事件物化）。
 * @returns {object} session 子状态
 */
export function createEmptySessionState() {
	return {
		chars: {},
		world: null,
		channelWorlds: {},
		personas: {},
		plugins: {},
		charFrequencies: {},
	}
}

/**
 * 创建新建群组的初始物化状态。
 * @param {string} groupId 群组 ID
 * @param {string} creatorPubKeyHash 创建者公钥哈希
 * @returns {object} 新建群组的初始物化状态
 */
export function createInitialState(groupId, creatorPubKeyHash) {
	const defaultChannelId = `channel_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`

	return {
		groupId,
		members: {
			[creatorPubKeyHash]: {
				pubKeyHash: creatorPubKeyHash,
				roles: ['admin', '@everyone'],
				joinedAt: Date.now(),
				status: 'active'
			}
		},
		membersRoot: null,
		membersPagesCount: 1,
		roles: createDefaultRoles(),
		channelPermissions: {},
		channels: {
			[defaultChannelId]: {
				id: defaultChannelId,
				type: 'text',
				name: '',
				description: '',
				parentChannelId: null,
				syncScope: 'group',
				isPrivate: false,
				createdAt: Date.now(),
			}
		},
		fileFolders: {},
		groupMeta: { name: '', description: '', avatar: null },
		groupSettings: { ...DEFAULT_GROUP_SETTINGS, defaultChannelId },
		reputationLedger: [],
		inviteEdges: [],
		gshRotations: [],
		pexHints: [],
		messageOverlay: emptyMessageOverlay(),
		messageSenderIndex: {},
		checkpoint_event_id: null,
		epoch_id: 0,
		epoch_root_hash: null,
		bannedMembers: new Set(),
		bannedEntities: new Set(),
		bannedNodes: new Set(),
		session: createEmptySessionState(),
	}
}

/**
 * @param {object} state 物化群状态
 * @param {string} sender pubKeyHash
 * @param {object} [joinContent] member_join content
 * @returns {boolean} 是否被任一 ban 规则拒绝
 */
function isJoinBanned(state, sender, joinContent = {}) {
	if (state.bannedMembers?.has?.(sender)) return true
	const home = String(joinContent.homeNodeHash || state.members?.[sender]?.homeNodeHash || '').trim().toLowerCase()
	if (/^[\da-f]{64}$/u.test(home)) {
		if (state.bannedNodes?.has?.(home)) return true
		const entityHash = `${home}${sender}`
		if (state.bannedEntities?.has?.(entityHash)) return true
	}
	return false
}

/**
 * @param {object} state 物化群状态
 * @param {object} content member_ban content
 * @returns {void}
 */
function applyBanContent(state, content) {
	const pk = String(content?.targetPubKeyHash || '').trim().toLowerCase()
	if (pk) state.bannedMembers.add(pk)
	const entity = String(content?.targetEntityHash || '').trim().toLowerCase()
	if (/^[\da-f]{128}$/u.test(entity)) state.bannedEntities.add(entity)
	const node = String(content?.targetNodeHash || '').trim().toLowerCase()
	if (/^[\da-f]{64}$/u.test(node)) state.bannedNodes.add(node)
}

/**
 * @param {object} state 物化群状态
 * @param {string} targetPubKeyHash 成员 pubKeyHash
 * @returns {void}
 */
function clearBanForMember(state, targetPubKeyHash) {
	const pk = String(targetPubKeyHash || '').trim().toLowerCase()
	if (!pk) return
	state.bannedMembers.delete(pk)
	const member = state.members?.[pk]
	const home = String(member?.homeNodeHash || '').trim().toLowerCase()
	if (/^[\da-f]{64}$/u.test(home)) {
		state.bannedNodes.delete(home)
		state.bannedEntities.delete(`${home}${pk}`)
	}
}

/**
 * 应用单条 DAG 事件到状态，返回新状态。
 * @param {object} state 当前状态
 * @param {object} event DAG 事件
 * @returns {object} 应用单条事件后的新状态
 */
export function applyEvent(state, event) {
	const newState = structuredClone(state)
	if (event?.groupId)
		newState.groupId = event.groupId

	switch (event.type) {
		case 'member_join': {
			if (!isJoinBanned(newState, event.sender, event.content)) {
				const activeBefore = Object.values(newState.members).filter(member => member?.status === 'active').length
				const extraRoles = activeBefore === 0 && Array.isArray(event.content?.roles)
					? event.content.roles.filter(roleId => typeof roleId === 'string' && roleId && roleId !== '@everyone' && newState.roles[roleId])
					: []
				const homeNodeHash = String(event.content?.homeNodeHash || event.senderHomeNodeHash || '').trim().toLowerCase()
				newState.members[event.sender] = {
					pubKeyHash: event.sender,
					pubKeyHex: event.senderPubKey || event.content?.pubKeyHex || null,
					homeNodeHash: /^[\da-f]{64}$/u.test(homeNodeHash) ? homeNodeHash : null,
					roles: ['@everyone', ...extraRoles],
					joinedAt: event.timestamp,
					status: 'active',
					repEdgeFromIntroducer: clampRepEdge(event.content?.reputationEdge),
				}
				const introducer = String(event.content?.introducerPubKeyHash || '').trim().toLowerCase()
				const joiner = String(event.sender || '').trim().toLowerCase()
				if (isHex64(introducer) && isHex64(joiner) && introducer !== joiner) {
					const dup = newState.inviteEdges.some(
						edge => edge.from === introducer && edge.to === joiner,
					)
					if (!dup) {
						const edge = { from: introducer, to: joiner, at: event.timestamp }
						if (event.content?.reputationEdge !== undefined)
							edge.reputationEdge = clampRepEdge(event.content.reputationEdge)
						newState.inviteEdges.push(edge)
					}
				}
			}
			break
		}

		case 'member_leave':
			if (newState.members[event.sender])
				newState.members[event.sender].status = 'left'
			break

		case 'member_kick':
			if (newState.members[event.content.targetPubKeyHash])
				newState.members[event.content.targetPubKeyHash].status = 'kicked'
			recordGshRotation(newState, event, 'kick', { targetPubKeyHash: event.content.targetPubKeyHash })
			break

		case 'member_ban':
			applyBanContent(newState, event.content || {})
			if (newState.members[event.content.targetPubKeyHash])
				newState.members[event.content.targetPubKeyHash].status = 'banned'
			break

		case 'member_unban':
			clearBanForMember(newState, event.content.targetPubKeyHash)
			if (newState.members[event.content.targetPubKeyHash])
				newState.members[event.content.targetPubKeyHash].status = 'active'
			break

		case 'role_create':
			newState.roles[event.content.roleId] = {
				name: event.content.name,
				color: event.content.color,
				position: event.content.position || 0,
				permissions: event.content.permissions,
				isDefault: false,
				isHoisted: event.content.isHoisted || false
			}
			break

		case 'role_update':
			if (newState.roles[event.content.roleId])
				Object.assign(newState.roles[event.content.roleId], event.content.updates)
			break

		case 'role_delete':
			delete newState.roles[event.content.roleId]
			for (const member of Object.values(newState.members))
				member.roles = member.roles.filter(role => role !== event.content.roleId)
			break

		case 'role_assign':
			if (newState.members[event.content.targetPubKeyHash])
				if (!newState.members[event.content.targetPubKeyHash].roles.includes(event.content.roleId))
					newState.members[event.content.targetPubKeyHash].roles.push(event.content.roleId)
			break

		case 'role_revoke':
			if (newState.members[event.content.targetPubKeyHash])
				newState.members[event.content.targetPubKeyHash].roles =
					newState.members[event.content.targetPubKeyHash].roles.filter(role => role !== event.content.roleId)
			break

		case 'channel_create':
			newState.channels[event.content.channelId] = {
				id: event.content.channelId,
				type: event.content.type,
				name: event.content.name,
				description: event.content.description ?? '',
				parentChannelId: event.content.parentChannelId || null,
				parentEventId: event.content.parentEventId || null,
				syncScope: event.content.syncScope || 'group',
				isPrivate: event.content.isPrivate || false,
				subRoomId: event.content.subRoomId || null,
				createdAt: event.timestamp,
			}
			break

		case 'channel_update':
			if (newState.channels[event.content.channelId])
				Object.assign(newState.channels[event.content.channelId], event.content.updates)
			break

		case 'channel_delete':
			delete newState.channels[event.content.channelId]
			for (const [id, channel] of Object.entries(newState.channels))
				if (channel.parentChannelId === event.content.channelId)
					delete newState.channels[id]
			break

		case 'list_item_update':
			if (newState.channels[event.channelId])
				newState.channels[event.channelId].manualItems = event.content.items
			break

		case 'group_meta_update':
			Object.assign(newState.groupMeta, event.content)
			break

		case 'group_settings_update': {
			const content = { ...event.content }
			const ownerHash = content.delegatedOwnerPubKeyHash
			delete content.delegatedOwnerPubKeyHash
			if (content.iceServers !== undefined)
				content.iceServers = sanitizeIceServersForSettings(content.iceServers)
			if (Object.keys(content).length)
				Object.assign(newState.groupSettings, content)
			if (ownerHash !== undefined) {
				const h = String(ownerHash || '').trim().toLowerCase()
				newState.delegatedOwnerPubKeyHash = isHex64(h) ? h : null
			}
			break
		}

		case 'message': {
			const eventId = String(event.id || '').trim().toLowerCase()
			if (isHex64(eventId)) {
				const channelId = event.channelId || event.content?.channelId || 'default'
				const sender = String(event.sender || '').trim().toLowerCase()
				if (!newState.messageSenderIndex) newState.messageSenderIndex = {}
				const charOwnerRaw = event.content?.charOwner
				newState.messageSenderIndex[eventId] = {
					sender,
					charOwner: charOwnerRaw ? String(charOwnerRaw).trim().toLowerCase() : null,
					charId: event.charId || null,
					channelId,
				}
			}
			break
		}

		case 'message_delete': {
			const targetId = String(event.content?.targetId || '').trim().toLowerCase()
			if (targetId) newState.messageOverlay.deletedIds.add(targetId)
			if (targetId && newState.messageSenderIndex) delete newState.messageSenderIndex[targetId]
			break
		}

		case 'message_edit': {
			const targetId = String(event.content?.targetId || '').trim().toLowerCase()
			if (targetId)
				newState.messageOverlay.editHistory.set(targetId, event.content.newContent)
			break
		}

		case 'reaction_add': {
			const targetId = String(event.content?.targetId || '').trim().toLowerCase()
			const emoji = event.content?.emoji
			if (!targetId || !emoji) break
			const key = `${targetId}:${emoji}`
			const senderHash = String(event.sender || '').trim().toLowerCase()
			if (!isHex64(senderHash)) break
			let voters = newState.messageOverlay.reactions.get(key)
			if (!voters) {
				voters = new Set()
				newState.messageOverlay.reactions.set(key, voters)
			}
			voters.add(senderHash)
			break
		}

		case 'reaction_remove': {
			const targetId = String(event.content?.targetId || '').trim().toLowerCase()
			const emoji = event.content?.emoji
			if (!targetId || !emoji) break
			const key = `${targetId}:${emoji}`
			const voters = newState.messageOverlay.reactions.get(key)
			if (!voters) break
			const voterHash = String(event.content?.targetPubKeyHash || event.sender || '').trim().toLowerCase()
			if (isHex64(voterHash)) voters.delete(voterHash)
			if (!voters.size) newState.messageOverlay.reactions.delete(key)
			break
		}

		case 'pin_message': {
			if (!newState.messageOverlay.pins.has(event.channelId))
				newState.messageOverlay.pins.set(event.channelId, [])
			const pins = newState.messageOverlay.pins.get(event.channelId)
			if (!pins.includes(event.content.targetId))
				pins.push(event.content.targetId)
			break
		}

		case 'unpin_message':
			if (newState.messageOverlay.pins.has(event.channelId))
				newState.messageOverlay.pins.set(
					event.channelId,
					newState.messageOverlay.pins.get(event.channelId).filter(id => id !== event.content.targetId)
				)
			break

		case 'vote_cast': {
			const { ballotId, choice } = event.content || {}
			if (!ballotId || choice == null || !event.sender) break
			if (!newState.messageOverlay.votes.has(ballotId))
				newState.messageOverlay.votes.set(ballotId, new Map())
			newState.messageOverlay.votes.get(ballotId).set(event.sender, String(choice))
			break
		}

		case 'file_upload': {
			const sender = String(event.sender || '').trim().toLowerCase()
			const uploaderPubKeyHash = isHex64(sender) ? sender : null
			newState.messageOverlay.fileIndex.set(event.content.fileId, {
				name: event.content.name,
				size: event.content.size,
				mimeType: event.content.mimeType,
				folderId: event.content.folderId,
				contentHash: event.content.contentHash ?? null,
				ciphertextHash: event.content.ciphertextHash ?? null,
				wrappedKey: event.content.wrappedKey ?? null,
				key_generation: event.content.key_generation ?? null,
				storageLocator: event.content.storageLocator ?? null,
				parts: Array.isArray(event.content.parts) ? event.content.parts : null,
				uploaderPubKeyHash,
			})
			break
		}

		case 'file_delete':
			newState.messageOverlay.fileIndex.delete(event.content.fileId)
			break

		case 'file_system_update': {
			const { operation, folderId } = event.content || {}
			const fid = String(folderId || '').trim()
			if (!fid) break
			switch (operation) {
				case 'create':
					newState.fileFolders[fid] = {
						name: event.content.name || fid,
						parentFolderId: event.content.parentFolderId ?? null,
					}
					break
				case 'rename':
					if (newState.fileFolders[fid])
						newState.fileFolders[fid].name = event.content.name || newState.fileFolders[fid].name
					break
				case 'move':
					if (newState.fileFolders[fid])
						newState.fileFolders[fid].parentFolderId = event.content.parentFolderId ?? null
					break
				case 'delete':
					delete newState.fileFolders[fid]
					break
				default:
					break
			}
			break
		}

		case 'channel_permissions_update':
			if (!newState.channelPermissions[event.content.channelId])
				newState.channelPermissions[event.content.channelId] = {}
			newState.channelPermissions[event.content.channelId][event.content.roleId] = {
				allow: event.content.allow || {},
				deny: event.content.deny || {}
			}
			break

		case 'reputation_slash': {
			const targetPubKeyHash = event.content?.targetPubKeyHash
			if (targetPubKeyHash)
				newState.reputationLedger.push({
					targetPubKeyHash,
					sender: event.sender,
					timestamp: event.timestamp,
					kind: 'slash',
					payloadRef: event.id,
				})
			break
		}

		case 'reputation_reset': {
			const targetPubKeyHash = event.content?.targetPubKeyHash
			if (targetPubKeyHash) {
				newState.reputationLedger = newState.reputationLedger.filter(
					entry => !(entry?.kind === 'slash' && entry?.targetPubKeyHash === targetPubKeyHash)
				)
				newState.reputationLedger.push({
					targetPubKeyHash,
					sender: event.sender,
					timestamp: event.timestamp,
					kind: 'reset',
				})
			}
			break
		}

		case 'dag_tip_merge':
			// 纯拓扑合并事件：不修改物化成员/频道，仅收敛多父（§0 多父 DAG）。
			break

		case 'key_rotate':
			recordGshRotation(newState, event, 'rotate')
			break

		case 'peer_invite': {
			const content = event.content
			const from = content.from || null
			const to = content.to || null
			if (from && to) {
				const edge = { from, to, at: event.timestamp }
				if (content.reputationEdge !== undefined) edge.reputationEdge = clampRepEdge(content.reputationEdge)
				// §11.1 §6.3：encrypted_H 供接收方（新成员）用自身私钥解密获取当前 H
				if (content.encrypted_H) edge.encrypted_H = content.encrypted_H
				newState.inviteEdges.push(edge)
			}
			break
		}

		case 'session_char_bind': {
			if (!newState.session) newState.session = createEmptySessionState()
			const charname = String(event.content?.charname || '').trim()
			if (!charname) break
			newState.session.chars[charname] = {
				ownerUsername: String(event.content?.ownerUsername || '').trim(),
				homeNodeHash: String(event.content?.homeNodeHash || '').trim().toLowerCase(),
			}
			break
		}

		case 'session_char_unbind': {
			if (!newState.session) break
			const charname = String(event.content?.charname || '').trim()
			if (charname) delete newState.session.chars[charname]
			break
		}

		case 'session_world_bind': {
			if (!newState.session) newState.session = createEmptySessionState()
			newState.session.world = {
				worldname: String(event.content?.worldname || '').trim(),
				ownerUsername: String(event.content?.ownerUsername || '').trim(),
				homeNodeHash: String(event.content?.homeNodeHash || '').trim().toLowerCase(),
			}
			break
		}

		case 'session_world_bind_channel': {
			if (!newState.session) newState.session = createEmptySessionState()
			const channelId = String(event.content?.channelId || '').trim()
			if (!channelId) break
			newState.session.channelWorlds[channelId] = {
				worldname: String(event.content?.worldname || '').trim(),
				ownerUsername: String(event.content?.ownerUsername || '').trim(),
				homeNodeHash: String(event.content?.homeNodeHash || '').trim().toLowerCase(),
			}
			break
		}

		case 'session_world_clear': {
			if (!newState.session) break
			const channelId = String(event.content?.channelId || '').trim()
			if (channelId) delete newState.session.channelWorlds[channelId]
			else newState.session.world = null
			break
		}

		case 'session_persona_set': {
			if (!newState.session) newState.session = createEmptySessionState()
			const ownerUsername = String(event.content?.ownerUsername || '').trim()
			if (!ownerUsername) break
			const personaname = event.content?.personaname
			if (personaname == null || personaname === '')
				delete newState.session.personas[ownerUsername]
			else
				newState.session.personas[ownerUsername] = String(personaname).trim()
			break
		}

		case 'session_plugin_add': {
			if (!newState.session) newState.session = createEmptySessionState()
			const ownerUsername = String(event.content?.ownerUsername || '').trim()
			const pluginname = String(event.content?.pluginname || '').trim()
			if (!ownerUsername || !pluginname) break
			if (!newState.session.plugins[ownerUsername])
				newState.session.plugins[ownerUsername] = []
			if (!newState.session.plugins[ownerUsername].includes(pluginname))
				newState.session.plugins[ownerUsername].push(pluginname)
			break
		}

		case 'session_plugin_remove': {
			if (!newState.session) break
			const ownerUsername = String(event.content?.ownerUsername || '').trim()
			const pluginname = String(event.content?.pluginname || '').trim()
			if (!ownerUsername || !pluginname) break
			const list = newState.session.plugins[ownerUsername]
			if (!Array.isArray(list)) break
			newState.session.plugins[ownerUsername] = list.filter(name => name !== pluginname)
			if (!newState.session.plugins[ownerUsername].length)
				delete newState.session.plugins[ownerUsername]
			break
		}

		case 'session_char_frequency_set': {
			if (!newState.session) newState.session = createEmptySessionState()
			const charname = String(event.content?.charname || '').trim()
			if (!charname) break
			const frequency = Number(event.content?.frequency)
			if (!Number.isFinite(frequency)) break
			newState.session.charFrequencies[charname] = frequency
			break
		}

	}

	refreshMembersDigest(newState)
	return newState
}

/**
 * 空物化状态（尚无 checkpoint、尚未重放事件时）。
 * @returns {object} 可传入 `applyEvent` 的初始状态
 */
export function emptyMaterializedState() {
	return {
		groupId: '',
		members: {},
		membersRoot: null,
		membersPagesCount: 1,
		roles: {},
		channelPermissions: {},
		channels: {},
		fileFolders: {},
		groupMeta: { name: '', description: '', avatar: null },
		groupSettings: { ...DEFAULT_GROUP_SETTINGS, defaultChannelId: null },
		reputationLedger: [],
		inviteEdges: [],
		gshRotations: [],
		pexHints: [],
		messageOverlay: emptyMessageOverlay(),
		checkpoint_event_id: null,
		epoch_id: 0,
		epoch_root_hash: null,
		bannedMembers: new Set(),
		bannedEntities: new Set(),
		bannedNodes: new Set(),
		delegatedOwnerPubKeyHash: null,
		ownerHeartbeats: {},
		session: createEmptySessionState(),
	}
}

/**
 * 从磁盘 checkpoint 还原运行时物化状态（Set/Map 等）。
 * @param {object} checkpoint `checkpoint.json` 解析对象
 * @returns {object} 与 `applyEvent` 输出同形的物化状态
 */
export function materializeFromCheckpoint(checkpoint) {
	const membersRecord = checkpoint.members_record
	const rawMo = membersRecord.messageOverlay

	return {
		groupId: membersRecord.groupId,
		members: structuredClone(membersRecord.members),
		membersRoot: membersRecord.membersRoot,
		membersPagesCount: membersRecord.membersPagesCount,
		roles: structuredClone(membersRecord.roles),
		channelPermissions: structuredClone(membersRecord.channelPermissions),
		channels: structuredClone(membersRecord.channels),
		fileFolders: structuredClone(membersRecord.fileFolders),
		groupMeta: structuredClone(membersRecord.groupMeta),
		groupSettings: structuredClone(membersRecord.groupSettings),
		messageOverlay: {
			deletedIds: new Set(rawMo.deletedIds),
			editHistory: new Map(Object.entries(rawMo.editHistory)),
			reactions: new Map(reactionsEntriesFromOverlay(rawMo)),
			pins: new Map(Object.entries(rawMo.pins)),
			fileIndex: new Map(Object.entries(rawMo.fileIndex)),
			votes: new Map(votesEntriesFromOverlay(rawMo)),
		},
		pexHints: [...membersRecord.pexHints],
		checkpoint_event_id: checkpoint.checkpoint_event_id,
		epoch_id: checkpoint.epoch_id,
		epoch_root_hash: checkpoint.epoch_root_hash,
		bannedMembers: new Set(membersRecord.bannedMembers),
		bannedEntities: new Set(membersRecord.bannedEntities),
		bannedNodes: new Set(membersRecord.bannedNodes),
		delegatedOwnerPubKeyHash: membersRecord.delegatedOwnerPubKeyHash,
		ownerHeartbeats: structuredClone(membersRecord.ownerHeartbeats),
		reputationLedger: structuredClone(membersRecord.reputationLedger),
		inviteEdges: structuredClone(membersRecord.inviteEdges),
		gshRotations: structuredClone(membersRecord.gshRotations),
		messageSenderIndex: structuredClone(membersRecord.messageSenderIndex),
		session: structuredClone(membersRecord.session),
	}
}

/**
 * 当前物化状态下具备 `ADMIN` 的成员公钥指纹集合。
 * @param {object} state 物化状态
 * @returns {Set<string>} 管理员 pubKeyHash
 */
export function adminPubKeyHashes(state) {
	const out = new Set()
	for (const [key, member] of Object.entries(state.members)) {
		if (member?.status !== 'active') continue
		const hash = member.pubKeyHash || key
		for (const roleId of member.roles || [])
			if (state.roles[roleId]?.permissions?.ADMIN) {
				out.add(hash)
				break
			}
	}
	return out
}

/**
 * 具备 `MANAGE_ADMINS` 的活跃成员公钥指纹（群主继任后的 checkpoint 签名人选）。
 * @param {object} state 物化状态
 * @returns {Set<string>} pubKeyHash 集合
 */
export function manageAdminsPubKeyHashes(state) {
	const out = new Set()
	for (const [key, member] of Object.entries(state.members)) {
		if (member?.status !== 'active') continue
		const hash = String(member.pubKeyHash || key).trim().toLowerCase()
		if (!isHex64(hash)) continue
		for (const roleId of member.roles || [])
			if (state.roles[roleId]?.permissions?.MANAGE_ADMINS) {
				out.add(hash)
				break
			}
	}
	return out
}

/**
 * 可签署 checkpoint 的公钥指纹：显式 `delegatedOwner` → `MANAGE_ADMINS` 持有者 → `ADMIN` 持有者。
 * @param {object} state 物化状态
 * @returns {Set<string>} 允许签名的 pubKeyHash
 */
export function checkpointSignerPubKeyHashes(state) {
	const delegated = String(state.delegatedOwnerPubKeyHash || '').trim().toLowerCase()
	if (isHex64(delegated)) return new Set([delegated])
	const manage = manageAdminsPubKeyHashes(state)
	if (manage.size) return manage
	return adminPubKeyHashes(state)
}

/**
 * 某成员在某频道上的有效权限表（用于发送前 gate）。
 * @param {object} state 物化状态
 * @param {string} senderPubKeyHash 发送方 pubKeyHash（hex）
 * @param {string} channelId 频道 ID
 * @returns {Record<string, boolean>} 权限键 → 是否允许
 */
export function memberChannelPermissions(state, senderPubKeyHash, channelId) {
	const memberKey = String(senderPubKeyHash).toLowerCase()
	if (state.members[memberKey]?.status !== 'active')
		return Object.fromEntries(Object.values(PERMISSIONS).map(permission => [permission, false]))

	return calculateMemberPermissions(
		state.members[memberKey],
		state.roles,
		channelId,
		state.channelPermissions
	)
}

/**
 * 从事件列表构建状态
 * @param {string} groupId 群组 ID
 * @param {string} creatorPubKeyHash 创建者公钥哈希
 * @param {Array} events 事件列表
 * @returns {object} 重放全部事件后的物化状态
 */
export function buildStateFromEvents(groupId, creatorPubKeyHash, events) {
	let state = createInitialState(groupId, creatorPubKeyHash)
	for (const event of events)
		state = applyEvent(state, event)
	return state
}
