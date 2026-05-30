/**
 * 【文件】public/src/deepLinkConsume.mjs
 * 【职责】消费 fount://run 与 ?invite= 深链：入群、建 DM、暂存待处理邀请。
 */

import { createDirectMessageByPubKeys, getFederationSettings, getGroupState, joinGroup } from './api/groupApi.mjs'
import { isHex64 } from './lib/pubKeyHex.mjs'
import { parseDmRunUri, parseJoinRunUri } from './lib/runUri.mjs'
import { resolvePowForJoin } from './powJoin.mjs'

/** sessionStorage 键：Hub 落地页暂存 `?invite=` 入群参数，供 `applyChatRunUri` 消费后清除。 */
export const PENDING_INVITE_STORAGE_KEY = 'fount_chat_pending_invite'

/**
 * 从当前页 query 解析 `fount://run/…` 深链（`url` 或 `run` 参数）。
 * @returns {string | null} 规范化后的 run URI，无则 `null`
 */
export function runUriFromPageLocation() {
	const query = new URLSearchParams(window.location.search)
	const urlParam = query.get('url')
	if (urlParam?.trim().startsWith('fount://')) return urlParam.trim()
	const runParam = query.get('run')
	if (!runParam?.trim()) return null
	const raw = runParam.trim()
	return raw.startsWith('fount://') ? raw : `fount://${raw}`
}

/**
 * 解析并执行 chat 深链：DM 建联或带邀请码入群。
 * @param {string} raw `fount://run/shells:chat/…` 完整 URI
 * @returns {Promise<{ kind: 'dm' | 'join', groupId: string, channelId: string } | null>} 成功时含目标群与频道；无法识别时 `null`
 */
export async function applyChatRunUri(raw) {
	const dm = parseDmRunUri(raw)
	if (dm) {
		const { identityPubKeyHex } = await getFederationSettings()
		if (!isHex64(identityPubKeyHex))
			throw new Error('configure identityPubKeyHex in federation settings first')
		const data = await createDirectMessageByPubKeys(identityPubKeyHex, dm.pubKeyHex, {
			dmIntroNonce: dm.nonce,
			dmIntroSignatureHex: dm.introSignatureHex,
		})
		return {
			kind: 'dm',
			groupId: data.groupId,
			channelId: data.defaultChannelId || data.channelId || 'default',
		}
	}

	const join = parseJoinRunUri(raw)
	if (join) {
		let state = null
		try { state = await getGroupState(join.groupId) }
		catch { /* non-member may still read policy from partial state */ }
		const pow = await resolvePowForJoin(join.groupId, state)
		const fedBootstrap = join.mqttRoomSecret || join.introducerPubKeyHex
			? {
				...join.mqttRoomSecret ? { mqttRoomSecret: join.mqttRoomSecret } : {},
				...join.introducerPubKeyHex ? { introducerPubKeyHash: join.introducerPubKeyHex } : {},
			}
			: null
		await joinGroup(join.groupId, join.inviteCode, null, pow, fedBootstrap)
		sessionStorage.removeItem(PENDING_INVITE_STORAGE_KEY)
		return { kind: 'join', groupId: join.groupId, channelId: 'default' }
	}

	return null
}
