/**
 * 历史 GSH 代际批量授予（补拉 inner.gshGrant / peer_invite）。
 */
import { Buffer } from 'node:buffer'

import { decryptH, encryptHForMember } from '../../../../../../../scripts/p2p/gsh.mjs'
import { isHex64, normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { resolveLocalEventSigner } from '../dag/localSigner.mjs'

import { flushGshBufferAfterRotation } from './buffer.mjs'
import { appendH, loadGsh } from './store.mjs'

/**
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {string} recipientEdPubKeyHex 接收方 Ed25519 公钥 hex
 * @returns {Promise<{ generations: Array<{ gen: number, encrypted_H: object }> }>} grant bundle
 */
export async function buildGshGenerationGrant(username, groupId, recipientEdPubKeyHex) {
	const recipient = normalizeHex64(recipientEdPubKeyHex)
	if (!recipient || Buffer.from(recipient, 'hex').length !== 32)
		throw new Error('invalid recipient Ed25519 pub key')
	const data = await loadGsh(username, groupId)
	const generations = (data.generations || []).map(entry => ({
		gen: entry.gen,
		encrypted_H: encryptHForMember(entry.h, recipient),
	}))
	return { generations }
}

/**
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {{ generations?: Array<{ gen?: number, encrypted_H?: object }> }} grant grant bundle
 * @returns {Promise<number>} 新导入的代数条数
 */
export async function applyGshGenerationGrant(username, groupId, grant) {
	const rows = Array.isArray(grant?.generations) ? grant.generations : []
	if (!rows.length) return 0
	let signer
	try {
		signer = await resolveLocalEventSigner(username, groupId)
	}
	catch {
		return 0
	}
	let imported = 0
	let maxGen = -1
	for (const row of rows) {
		const gen = Number(row?.gen)
		const encrypted = row?.encrypted_H
		if (!Number.isFinite(gen) || gen < 0 || !encrypted) continue
		const hHex = decryptH(encrypted, signer.secretKey)
		if (!hHex || !isHex64(hHex)) continue
		await appendH(username, groupId, Math.floor(gen), hHex)
		imported++
		if (gen > maxGen) maxGen = Math.floor(gen)
	}
	if (maxGen >= 0)
		flushGshBufferAfterRotation(username, groupId, maxGen)
	return imported
}
