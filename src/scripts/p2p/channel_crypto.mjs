/**
 * 频道域密钥 K_ch：HPKE 包装（X25519 ECIES）与 AES-GCM 消息信封（scheme: ckg）。
 */
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { decryptH, encryptHForMember, generateH } from './gsh.mjs'

/** @typedef {{ ephemPub: string, iv: string, ciphertext: string, authTag: string }} HpkeWrapBlob */

/**
 * 生成随机 32 字节频道密钥（hex）。
 * @returns {string} 32 字节 hex 频道密钥
 */
export function generateChannelKey() {
	return generateH()
}

/**
 * HPKE 包装 K_ch 给成员 Ed25519 公钥。
 * @param {string} channelKeyHex 32 字节 hex
 * @param {string} memberEdPubKeyHex 64 hex
 * @returns {HpkeWrapBlob} HPKE 包装结果
 */
export function wrapChannelKey(channelKeyHex, memberEdPubKeyHex) {
	return encryptHForMember(channelKeyHex, memberEdPubKeyHex)
}

/**
 * @param {HpkeWrapBlob} wrap HPKE 密文
 * @param {Uint8Array} myEdPrivKeySeed 32 字节 Ed25519 种子
 * @returns {string | null} K_ch hex
 */
export function unwrapChannelKey(wrap, myEdPrivKeySeed) {
	return decryptH(wrap, myEdPrivKeySeed)
}

/**
 * @param {string} channelKeyHex K_ch
 * @param {string} channelId 频道 id（AAD 盐）
 * @param {number} generation 代际
 * @returns {Buffer} 消息 AES-256 密钥
 */
function messageAesKey(channelKeyHex, channelId, generation) {
	return createHash('sha256')
		.update(Buffer.from(channelKeyHex, 'hex'))
		.update('ckg-v1')
		.update(String(channelId))
		.update(String(generation))
		.digest()
}

/**
 * @param {string} plaintext UTF-8 / JSON 字符串
 * @param {string} channelKeyHex K_ch
 * @param {string} channelId 频道 ID
 * @param {number} generation 密钥代际
 * @returns {{ scheme: 'ckg', channelId: string, generation: number, iv: string, ciphertext: string, authTag: string }} ckg 信封
 */
export function encryptWithChannelKey(plaintext, channelKeyHex, channelId, generation) {
	const key = messageAesKey(channelKeyHex, channelId, generation)
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const plain = Buffer.from(String(plaintext), 'utf8')
	const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
	return {
		scheme: 'ckg',
		channelId: String(channelId),
		generation: Number(generation) || 0,
		iv: iv.toString('base64'),
		ciphertext: ciphertext.toString('base64'),
		authTag: cipher.getAuthTag().toString('base64'),
	}
}

/**
 * @param {{ scheme?: string, channelId?: string, generation?: number, iv: string, ciphertext: string, authTag: string }} envelope ckg 信封
 * @param {string} channelKeyHex K_ch
 * @param {string} channelId 频道 ID
 * @returns {string | null} 明文 UTF-8
 */
export function decryptWithChannelKey(envelope, channelKeyHex, channelId) {
	if (!envelope || envelope.scheme !== 'ckg') return null
	try {
		const generation = Number(envelope.generation) || 0
		const key = messageAesKey(channelKeyHex, channelId || envelope.channelId, generation)
		const iv = Buffer.from(envelope.iv, 'base64')
		const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
		const authTag = Buffer.from(envelope.authTag, 'base64')
		const decipher = createDecipheriv('aes-256-gcm', key, iv)
		decipher.setAuthTag(authTag)
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
	}
	catch { return null }
}
