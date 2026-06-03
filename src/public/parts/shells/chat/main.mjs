/**
 * 【文件】main.mjs
 * 【职责】chat shell 的 Part 入口：向 parts_loader 导出 shellAPI_t，注册 HTTP/群路由与文件 GC，并分发 CLI/IPC 动作。
 * 【原理】side-effect 预加载 dag/index；Load 调用 setGroupEndpoints + setEndpoints；Unload 在 loadCount 归零时 clearInterval(cleanFilesInterval)。
 *   handleAction 动态 import actions 表；ArgumentsHandler 解析 dm/join/start/send 等；IPCInvokeHandler 透传 command。
 * 【数据结构】loadCount、shellAPI_t（info/Load/Unload/interfaces）、actions 命令键。
 * 【关联】parts_loader 加载；import endpoints、group/endpoints、files、locales。
 */
import './src/chat/dag/index.mjs'
import './src/chat/federation/config.mjs'
import { registerMaterializedSessionProvider, unregisterMaterializedSessionProvider } from '../../../../scripts/p2p/entity/session_snapshot_registry.mjs'
import { normalizeHex64 } from '../../../../scripts/p2p/hexIds.mjs'
import { registerGroupMemberEntityResolver, unregisterGroupMemberEntityResolver } from '../../../../scripts/p2p/p2p_viewer_registry.mjs'
import {
	registerShellPartpath,
	unregisterShellPartpath,
} from '../../../../scripts/p2p/part_path_registry.mjs'
import { isPlainObject } from '../../../../scripts/p2p/wire_ingress.mjs'

import { registerChatChunkProviders, unregisterChatChunkProviders } from './src/chat/chunkProviders.mjs'
import { registerChatFederationRoomProvider, unregisterChatFederationRoomProvider } from './src/chat/federation/trustGraphRooms.mjs'
import { registerChatGroupEntityIndex, unregisterChatGroupEntityIndex } from './src/chat/groupEntityIndex.mjs'
import { getGroupMemberEntityHash } from './src/chat/lib/replica.mjs'
import {
	getMailboxRecords,
	ingestMailboxGive,
	ingestMailboxPut,
	parseMailboxGive,
	parseMailboxPut,
	parseMailboxWant,
	takeMailboxForRecipient,
} from './src/chat/mailbox/delivery.mjs'
import { registerChatManifestAcl, unregisterChatManifestAcl } from './src/chat/manifestAcl.mjs'
import { registerChatManifestTransfer, unregisterChatManifestTransfer } from './src/chat/manifestTransfer.mjs'
import { getMaterializedSession } from './src/chat/session/dagSession.mjs'
import { setEndpoints } from './src/endpoints.mjs'
import { cleanFilesInterval } from './src/files.mjs'
import { setGroupEndpoints } from './src/group/endpoints.mjs'

const { info } = (await import('./locales.json', { with: { type: 'json' } })).default

let loadCount = 0

/**
 * @param {string} user replica 登录名
 * @param {object} data invoke 体（含 wire）
 * @returns {Promise<{ ok: boolean }>} put 成功
 */
async function handleMailboxPut(user, data) {
	const put = parseMailboxPut(data.wire)
	if (!put) throw new Error('invalid_mailbox_put')
	await ingestMailboxPut(user, put)
	return { ok: true }
}

/**
 * @param {string} user replica 登录名
 * @param {object} data invoke 体（含 wire）
 * @returns {Promise<{ kind: string, wire: object }>} want 应答或 follow-up give
 */
async function handleMailboxWant(user, data) {
	const want = parseMailboxWant(data.wire)
	if (!want) throw new Error('invalid_mailbox_want')
	const recipient = normalizeHex64(want.toPubKeyHash)
	if (!recipient) throw new Error('invalid_recipient')
	const ids = Array.isArray(want.ids) ? want.ids : []
	const rows = (ids.length
		? await getMailboxRecords(user, ids)
		: await takeMailboxForRecipient(user, recipient)
	).filter(row => row.toPubKeyHash === recipient && row.tier !== 'quarantine')
	if (!rows.length) throw new Error('mailbox_empty')
	return {
		kind: 'mailbox_give',
		wire: { toPubKeyHash: recipient, records: rows.slice(0, 32) },
	}
}

/**
 * @param {string} user replica 登录名
 * @param {object} data invoke 体（含 wire、可选 groupId）
 * @returns {Promise<{ ok: boolean }>} give ingest 成功
 */
async function handleMailboxGive(user, data) {
	const give = parseMailboxGive(data.wire)
	if (!give) throw new Error('invalid_mailbox_give')
	await ingestMailboxGive(user, String(data.groupId || ''), give)
	return { ok: true }
}

/** @type {Record<string, (user: string, data: object) => Promise<object | null>>} */
const p2pInvokeHandlers = {
	mailbox_put: handleMailboxPut,
	mailbox_want: handleMailboxWant,
	mailbox_give: handleMailboxGive,
}

/**
 * P2P part_invoke 入站 mailbox put/want/give。
 * @param {string} user replica 登录名
 * @param {object} data invoke 体（kind + wire + 可选 groupId）
 * @returns {Promise<object | null>} want 时返回 follow-up invoke 体
 */
async function handleChatP2PInvoke(user, data) {
	const kind = String(data?.kind || '')
	const handler = p2pInvokeHandlers[kind]
	return handler ? handler(user, data) : null
}

/**
 * 处理传入的聊天动作请求。
 * @param {string} user - 用户名。
 * @param {string} action - 要执行的动作名称。
 * @param {object} params - 动作所需的参数。
 * @returns {Promise<any>} - 返回动作执行的结果。
 */
async function handleAction(user, action, params) {
	const { actions } = await import('./src/actions.mjs')
	if (actions[action])
		return actions[action]({ user, ...params })

	const { actions: profileActions } = await import('./src/profile/actions.mjs')
	if (profileActions[action])
		return profileActions[action]({ user, ...params })

	const stickerActionMap = {
		'sticker-list': 'list',
		'sticker-create': 'create',
		'sticker-info': 'info',
		'sticker-install': 'install',
		'sticker-uninstall': 'uninstall',
		'sticker-delete': 'delete',
	}
	const stickerKey = stickerActionMap[action]
	if (stickerKey) {
		const { actions: stickerActions } = await import('./src/stickers/actions.mjs')
		if (stickerActions[stickerKey])
			return stickerActions[stickerKey]({ user, ...params })
	}

	throw new Error(`Unknown action: ${action}. Available actions: ${Object.keys(actions).join(', ')}`)
}

/**
 * 聊天Shell API
 * @type {import('../../../../../src/decl/shellAPI.ts').shellAPI_t}
 */
export default {
	info,
	/**
	 * 加载聊天Shell，设置API端点并增加加载计数。
	 * @param {object} root0 - 参数对象。
	 * @param {object} root0.router - Express的路由实例。
	 */
	Load: ({ router }) => {
		loadCount++
		registerShellPartpath('chat', 'shells/chat')
		registerChatManifestAcl()
		registerChatManifestTransfer()
		registerChatChunkProviders()
		registerChatGroupEntityIndex()
		registerGroupMemberEntityResolver('chat', getGroupMemberEntityHash)
		registerMaterializedSessionProvider('chat', getMaterializedSession)
		registerChatFederationRoomProvider()
		setGroupEndpoints(router)
		setEndpoints(router)
	},
	/**
	 * 卸载聊天Shell，减少加载计数并在必要时清理定时器。
	 */
	Unload: () => {
		loadCount--
		if (!loadCount) {
			clearInterval(cleanFilesInterval)
			unregisterShellPartpath('chat')
			unregisterChatManifestAcl()
			unregisterGroupMemberEntityResolver('chat')
			unregisterChatManifestTransfer()
			unregisterChatChunkProviders()
			unregisterChatGroupEntityIndex()
			unregisterMaterializedSessionProvider('chat')
			unregisterChatFederationRoomProvider()
		}
	},
	interfaces: {
		web: {},
		invokes: {
			/**
			 * 处理命令行参数以执行各种聊天操作。
			 * @param {string} user - 用户名。
			 * @param {Array<string>} args - 命令行参数数组。
			 * @returns {Promise<void>}
			 */
			ArgumentsHandler: async (user, args) => {
				const command = args[0]
				let params = {}
				let result

				switch (command) {
					case 'dm': {
						params = {
							introPubKeyHex: args[1],
							dmIntroNonce: args[2],
							dmIntroSignatureHex: args[3],
						}
						result = await handleAction(user, command, params)
						if (result?.groupId) console.log(JSON.stringify(result))
						break
					}
					case 'join': {
						params = { groupId: args[1], inviteCode: args[2] || '' }
						result = await handleAction(user, command, params)
						if (result?.groupId) console.log(JSON.stringify(result))
						break
					}
					case 'start':
						params = { charName: args[1] }
						result = await handleAction(user, command, params)
						break
					case 'asjson':
						params = { chatInfo: JSON.parse(args[1]) }
						result = await handleAction(user, command, params)
						break
					case 'load':
						params = { groupId: args[1] }
						result = await handleAction(user, command, params)
						break
					case 'tail':
						params = { groupId: args[1], n: Number(args[2] || '5') }
						result = await handleAction(user, command, params)
						result.forEach(log => {
							console.log(`[${new Date(log.time_stamp).toLocaleString()}] ${log.name}: ${log.content}`)
						})
						break
					case 'send':
						params = { groupId: args[1], message: { content: args[2] } }
						await handleAction(user, command, params)
						break
					default: {
						const [groupId, ...rest] = args.slice(1)
						const paramMap = {
							'remove-char': { charName: rest[0] },
							'set-persona': { personaName: rest[0] },
							'set-world': { worldName: rest[0] },
							'set-char-frequency': { charName: rest[0], frequency: parseFloat(rest[1]) },
							'trigger-reply': { charName: rest[0] },
						}
						params = { groupId, ...paramMap[command] }
						result = await handleAction(user, command, params)
						if (result !== undefined) console.log(result)
						break
					}
				}
			},
			/**
			 * 处理IPC调用以执行聊天操作。
			 * @param {string} user - 用户名。
			 * @param {object} data - 从IPC接收的数据对象。
			 * @returns {Promise<any>} - 动作执行结果。
			 */
			IPCInvokeHandler: async (user, data) => {
				const { command, ...params } = data
				return handleAction(user, command, params)
			},
			/**
			 * P2P part_invoke 入站 mailbox put/want/give。
			 * @param {string} user replica 登录名
			 * @param {object} data invoke 体（kind + wire + 可选 groupId）
			 * @param {{ requesterNodeHash?: string | null }} [ingress] 联邦入站元数据（Chat 未使用）
			 * @returns {Promise<object | null>} want 时返回 follow-up invoke 体
			 */
			P2PInvokeHandler: async (user, data) => {
				if (!isPlainObject(data.wire)) throw new Error('invalid_wire')
				return handleChatP2PInvoke(user, data)
			},
		}
	}
}
