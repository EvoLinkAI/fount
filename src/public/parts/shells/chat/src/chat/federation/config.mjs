/**
 * 【文件】federation/config.mjs
 * 【职责】节点级联邦中继与 identity；群级 MQTT 口令见 DAG groupSettings（mqttCredentials.mjs）。
 * 【原理】配置存 shells/chat/federation shellData；save 会 invalidate 已缓存 Trystero 房间。节点级联邦始终启用，不可关闭。
 * 【关联】registry.mjs、room.mjs、mqttCredentials.mjs、stream/signing.mjs。
 */
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

import { keyPairFromSeed } from '../../../../../../../scripts/p2p/crypto.mjs'
import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { assignShellData, loadShellData } from '../../../../../../../server/setting_loader.mjs'

import {
	federationRoomInflight,
	federationRoomRebindGeneration,
	federationRooms,
	groupFederationOwner,
} from './registry.mjs'

/**
 * @param {string} username 用户名
 * @returns {ReturnType<typeof getFederationSettings>} 合并后的配置
 */
export function ensureFederationDefaults(username) {
	ensureNodeIdentityPubKey(username)
	return getFederationSettings(username)
}

/**
 * @param {string} username 用户名
 * @returns {string} 64 位公钥 hex
 */
export function ensureNodeIdentityPubKey(username) {
	const { identityPubKeyHex } = getFederationSettings(username)
	if (isHex64(identityPubKeyHex)) return identityPubKeyHex
	const { publicKey, secretKey } = keyPairFromSeed(randomBytes(32))
	return saveFederationSettings(username, {
		identityPubKeyHex: Buffer.from(publicKey).toString('hex'),
		identitySecretKeyHex: Buffer.from(secretKey).toString('hex'),
	}).identityPubKeyHex
}

/**
 * @param {string} username 用户名
 * @returns {{ relayUrls: string[], batterySaver: boolean, identityPubKeyHex: string }} 节点联邦配置
 */
export function getFederationSettings(username) {
	const data = loadShellData(username, 'chat', 'federation') || {}
	const relayUrls = Array.isArray(data.relayUrls)
		? data.relayUrls.map(url => String(url).trim()).filter(url => url.startsWith('wss://'))
		: []
	const batterySaver = !!data.batterySaver
	const identityPubKeyHex = String(data.identityPubKeyHex || '').trim().toLowerCase().replace(/^0x/iu, '')
	return { relayUrls, batterySaver, identityPubKeyHex }
}

/**
 * 服务端内部：读取联邦 identity 私钥种子（不通过 HTTP 暴露）。
 * @param {string} username 用户名
 * @returns {string} 64 位私钥 hex；未配置时为空串
 */
export function getFederationIdentitySecret(username) {
	ensureNodeIdentityPubKey(username)
	const data = loadShellData(username, 'chat', 'federation') || {}
	return String(data.identitySecretKeyHex || '').trim().toLowerCase().replace(/^0x/iu, '')
}

/**
 * @param {string} username 用户名
 * @param {object} patch 部分字段
 * @returns {ReturnType<typeof getFederationSettings>} 合并后的节点联邦配置
 */
export function saveFederationSettings(username, patch) {
	const current = loadShellData(username, 'chat', 'federation') || {}
	const next = { ...current }
	delete next.enabled
	if (patch.batterySaver != null) next.batterySaver = !!patch.batterySaver
	if (patch.relayUrls)
		next.relayUrls = patch.relayUrls.map(url => url.trim()).filter(url => url.startsWith('wss://'))
	if (patch.identityPubKeyHex && isHex64(patch.identityPubKeyHex))
		next.identityPubKeyHex = patch.identityPubKeyHex.trim().toLowerCase().replace(/^0x/iu, '')
	if (patch.identitySecretKeyHex && isHex64(patch.identitySecretKeyHex))
		next.identitySecretKeyHex = patch.identitySecretKeyHex.trim().toLowerCase().replace(/^0x/iu, '')
	assignShellData(username, 'chat', 'federation', next)
	invalidateAllFederationRoomsForUser(username)
	void import('../stream/signing.mjs').then(module => module.invalidateStreamSignerCache(username)).catch(() => {})
	return getFederationSettings(username)
}

/**
 * @param {string} username 用户名
 */
export function invalidateAllFederationRoomsForUser(username) {
	const prefix = `${username}\0`
	for (const key of [...federationRooms.keys()])
		if (key.startsWith(prefix)) {
			federationRooms.delete(key)
			federationRoomInflight.delete(key)
			federationRoomRebindGeneration.set(key, (federationRoomRebindGeneration.get(key) || 0) + 1)
		}

	for (const groupId of [...groupFederationOwner.keys()])
		if (groupFederationOwner.get(groupId) === username)
			groupFederationOwner.delete(groupId)
}
