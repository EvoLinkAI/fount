/**
 * 从 DAG `peer_invite.encrypted_H` 导入群 GSH（本机成员 Ed25519 密钥解密）。
 */
import { Buffer } from 'node:buffer'

import { publicKeyFromSeed } from '../../../../../../../scripts/p2p/crypto.mjs'
import { decryptH } from '../../../../../../../scripts/p2p/gsh.mjs'
import { normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { resolveLocalEventSigner } from '../dag/localSigner.mjs'

import { appendH, getCurrentH } from './store.mjs'

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object} event 已落盘 DAG 事件
 * @returns {Promise<void>}
 */
export async function tryImportHFromPeerInvite(username, groupId, event) {
	if (event?.type !== 'peer_invite') return
	const encrypted = event.content?.encrypted_H
	if (!encrypted || typeof encrypted !== 'object') return

	let signer
	try {
		signer = await resolveLocalEventSigner(username, groupId)
	}
	catch { return }

	const myEdPubHex = Buffer.from(publicKeyFromSeed(signer.secretKey)).toString('hex')
	const toHex = normalizeHex64(event.content?.to)
	if (!toHex || toHex !== normalizeHex64(myEdPubHex)) return

	const hHex = decryptH(encrypted, signer.secretKey)
	if (!hHex || !/^[0-9a-f]{64}$/iu.test(hHex)) return

	const gen = Number(event.content?.h_generation)
	const targetGen = Number.isFinite(gen) && gen >= 0 ? Math.floor(gen) : null
	const current = await getCurrentH(username, groupId)

	if (current?.h === hHex) return

	if (targetGen != null) {
		if (!current || targetGen > current.generation)
			await appendH(username, groupId, targetGen, hHex)
		return
	}

	if (!current)
		await appendH(username, groupId, 0, hHex)
}
