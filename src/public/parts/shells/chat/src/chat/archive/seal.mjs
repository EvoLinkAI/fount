/**
 * 冷归档批次封口：owner 对 merkle(eventIds) 签名，不进 DAG。
 */
import { Buffer } from 'node:buffer'

import { canonicalStringify } from '../../../../../../../scripts/p2p/canonical_json.mjs'
import { pubKeyHash, publicKeyFromSeed, sign, verify } from '../../../../../../../scripts/p2p/crypto.mjs'
import { merkleRoot } from '../../../../../../../scripts/p2p/dag/index.mjs'
import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { checkpointSignerPubKeyHashes, materializeFromCheckpoint } from '../../../../../../../scripts/p2p/materialized_state.mjs'
import { readLocalSignerSeed } from '../dag/localSigner.mjs'
import { snapshotPath } from '../lib/paths.mjs'
import { safeReadJson } from '../lib/utils.mjs'

import { loadArchiveManifest, saveArchiveManifest } from './index.mjs'

/**
 * @param {string[]} eventIds 本批归档 message eventId
 * @returns {string[]} 规范化排序 id
 */
export function normalizeSealEventIds(eventIds) {
	return [...new Set(eventIds.map(id => String(id).trim().toLowerCase()).filter(isHex64))].sort()
}

/**
 * @param {object} payload 待签封口体
 * @param {Uint8Array} secretKey 32 字节种子
 * @returns {Promise<string>} 128 hex 签名
 */
async function signSealPayload(payload, secretKey) {
	const body = JSON.parse(JSON.stringify(payload))
	const messageBytes = Buffer.from(canonicalStringify(body), 'utf8')
	const signature = await sign(messageBytes, secretKey)
	return Buffer.from(signature).toString('hex')
}

/**
 * @param {object} seal 封口记录
 * @param {Uint8Array} ownerPublicKey 32 字节公钥
 * @returns {Promise<boolean>} 验签是否通过
 */
export async function verifyArchiveSeal(seal, ownerPublicKey) {
	const raw = String(seal?.ownerSignature || '').trim()
	if (!/^[\da-f]{128}$/iu.test(raw)) return false
	if (!(ownerPublicKey instanceof Uint8Array) || ownerPublicKey.length !== 32) return false
	const body = {
		groupId: String(seal.groupId || ''),
		channelId: String(seal.channelId || ''),
		throughEventId: String(seal.throughEventId || '').trim().toLowerCase(),
		merkleRoot: String(seal.merkleRoot || '').trim().toLowerCase(),
		sealedAt: Number(seal.sealedAt) || 0,
	}
	const messageBytes = Buffer.from(canonicalStringify(body), 'utf8')
	return verify(Buffer.from(raw, 'hex'), messageBytes, ownerPublicKey)
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {string[]} eventIds 本批新归档 eventId
 * @param {string} [throughEventId] 封口尖（默认 sorted 末 id）
 * @returns {Promise<object | null>} 写入 manifest 的 seal 或 null
 */
export async function sealArchiveChannelBatch(username, groupId, channelId, eventIds, throughEventId = null) {
	const ids = normalizeSealEventIds(eventIds)
	if (!ids.length) return null
	const secretKey = await readLocalSignerSeed(username, groupId)
	const checkpoint = await safeReadJson(snapshotPath(username, groupId))
	if (!checkpoint?.members_record) return null
	const state = materializeFromCheckpoint(checkpoint)
	const signers = checkpointSignerPubKeyHashes(state)
	const derived = publicKeyFromSeed(secretKey)
	const derivedHash = pubKeyHash(derived)
	if (!signers.has(derivedHash)) return null

	const tip = throughEventId && isHex64(throughEventId)
		? String(throughEventId).trim().toLowerCase()
		: ids[ids.length - 1]
	const root = merkleRoot(ids)
	const sealedAt = Date.now()
	const payload = {
		groupId: String(groupId),
		channelId: String(channelId),
		throughEventId: tip,
		merkleRoot: root,
		sealedAt,
	}
	const ownerSignature = await signSealPayload(payload, secretKey)
	const seal = { ...payload, ownerSignature, eventCount: ids.length }
	const manifest = await loadArchiveManifest(username, groupId)
	if (!manifest.seals) manifest.seals = {}
	manifest.seals[channelId] = seal
	if (manifest.coverage?.[channelId]) delete manifest.coverage[channelId]
	manifest.archive_coverage_complete = Object.values(manifest.coverage || {})
		.every(row => row?.complete !== false)
	await saveArchiveManifest(username, groupId, manifest)
	return seal
}

/**
 * @param {object} manifest archive manifest
 * @returns {object} 联邦同步用精简 manifest
 */
export function wireArchiveManifestForFederation(manifest) {
	return {
		version: manifest.version,
		monthBucketPolicy: manifest.monthBucketPolicy,
		channels: manifest.channels,
		seals: manifest.seals,
		monthDigests: manifest.monthDigests,
		coverage: manifest.coverage,
		archive_coverage_complete: manifest.archive_coverage_complete !== false,
	}
}
