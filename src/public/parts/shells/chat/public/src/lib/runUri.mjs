/** §16：`fount://run/shells:chat/{dm|join};…` 组装与解析（与 protocolhandler 分号参数一致）。 */

import { normalizePubKeyHex } from './pubKeyHex.mjs'

/**
 *
 */
export const CHAT_RUN_PART = 'parts:shells:chat'
const RUN_PREFIX = `fount://run/${CHAT_RUN_PART}/`

/**
 * @param {string} subcommand 子命令名
 * @param {string[]} segments 分号分段（将 encode）
 * @returns {string} `fount://run/…` URI
 */
function buildRunUri(subcommand, segments) {
	const body = [subcommand, ...segments.map(segment => encodeURIComponent(segment || ''))].join(';')
	return `${RUN_PREFIX}${body}`
}

/**
 * @param {object} options 参数
 * @param {string} options.pubKeyHex 介绍者公钥
 * @param {string} options.nonceBase64Url nonce
 * @param {string} options.introSignatureHex 签名
 * @param {string} [options.nodeUrl] 可选节点 URL
 * @returns {string} canonical DM run URI
 */
export function formatDmRunUri({ pubKeyHex, nonceBase64Url, introSignatureHex, nodeUrl }) {
	const segments = [
		normalizePubKeyHex(pubKeyHex),
		nonceBase64Url,
		String(introSignatureHex || '').trim().replace(/^0x/iu, ''),
	]
	if (nodeUrl) segments.push(String(nodeUrl).trim())
	return buildRunUri('dm', segments)
}

/**
 * @param {string} groupId 群 ID
 * @param {string} inviteCode 邀请码
 * @param {string} [mqttRoomSecret] 首次联邦 catch-up bootstrap 口令
 * @param {string} [introducerPubKeyHex] 邀请人 Ed25519 公钥 hex
 * @returns {string} canonical join run URI
 */
export function formatJoinRunUri(groupId, inviteCode, mqttRoomSecret, introducerPubKeyHex) {
	const segments = [groupId.trim(), inviteCode.trim()]
	if (mqttRoomSecret?.trim()) segments.push(mqttRoomSecret.trim())
	if (introducerPubKeyHex?.trim()) segments.push(normalizePubKeyHex(introducerPubKeyHex))
	return buildRunUri('join', segments)
}

/**
 * HTTPS 包装（站外分享 / 扫码）。
 * @param {string} fountRunUri `fount://run/…`
 * @returns {string} protocol 页 URL
 */
export function wrapProtocolHttpsUrl(fountRunUri) {
	return `https://steve02081504.github.io/fount/protocol?url=${encodeURIComponent(fountRunUri)}`
}

/**
 * 解析 `fount://run/shells:chat/…` 或裸 path（`parts:shells:chat/dm;…`）。
 * @param {string} raw 输入 URI
 * @returns {{ subcommand: string, args: string[] } | null} 解析结果，非 chat run URI 则 null
 */
export function parseChatRunUri(raw) {
	let input = String(raw || '').trim()
	if (!input) return null
	if (input.startsWith('fount://run/')) input = input.slice('fount://run/'.length)
	else if (input.startsWith('fount://')) return null

	const semi = input.indexOf(';')
	const slash = input.indexOf('/')
	let rest = input
	if (slash >= 0 && (semi < 0 || slash < semi)) {
		if (input.slice(0, slash) !== CHAT_RUN_PART) return null
		rest = input.slice(slash + 1)
	}
	else if (input.startsWith(`${CHAT_RUN_PART}/`))
		rest = input.slice(CHAT_RUN_PART.length + 1)
	else if (input.startsWith(`${CHAT_RUN_PART};`))
		rest = input.slice(CHAT_RUN_PART.length + 1)

	const parts = rest.split(';').map(segment => {
		try { return decodeURIComponent(segment) }
		catch { return segment }
	})
	const subcommand = parts[0]?.trim()
	if (!subcommand) return null
	return { subcommand, args: parts.slice(1) }
}

/**
 * @param {string} raw URI
 * @returns {{ pubKeyHex: string, nonce: string, introSignatureHex: string, nodeUrl?: string } | null} DM 载荷或 null
 */
export function parseDmRunUri(raw) {
	const parsed = parseChatRunUri(raw)
	if (!parsed || parsed.subcommand !== 'dm') return null
	const [pubKeyHex, nonce, introSignatureHex, nodeUrl] = parsed.args
	if (!pubKeyHex || !nonce || !introSignatureHex) return null
	return { pubKeyHex, nonce, introSignatureHex, nodeUrl: nodeUrl || undefined }
}

/**
 * @param {string} raw URI
 * @returns {{ groupId: string, inviteCode: string, mqttRoomSecret?: string, introducerPubKeyHex?: string } | null} join 载荷或 null
 */
export function parseJoinRunUri(raw) {
	const parsed = parseChatRunUri(raw)
	if (!parsed || parsed.subcommand !== 'join') return null
	const [groupId, inviteCode, mqttRoomSecret, introducerPubKeyHex] = parsed.args
	if (!groupId) return null
	return {
		groupId,
		inviteCode: inviteCode || '',
		mqttRoomSecret: mqttRoomSecret?.trim() || undefined,
		introducerPubKeyHex: introducerPubKeyHex?.trim() || undefined,
	}
}
