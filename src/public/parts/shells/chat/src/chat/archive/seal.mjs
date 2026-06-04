/**
 * 冷归档批次封口：owner 对 merkle(eventIds) 签名，不进 DAG。
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { canonicalStringify } from '../../../../../../../scripts/p2p/canonical_json.mjs'
import { pubKeyHash, publicKeyFromSeed, sign, verify } from '../../../../../../../scripts/p2p/crypto.mjs'
import { merkleRoot } from '../../../../../../../scripts/p2p/dag/index.mjs'
import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { checkpointSignerPubKeyHashes, materializeFromCheckpoint } from '../../../../../../../scripts/p2p/materialized_state.mjs'
import { readLocalSignerSeed } from '../dag/localSigner.mjs'
import { snapshotPath } from '../lib/paths.mjs'
import { safeReadJson } from '../lib/utils.mjs'

import { loadArchiveManifest, saveArchiveManifest } from './index.mjs'

/** 首条 seal 链的 prev 占位 */
export const GENESIS_PREV_SEAL_HASH = '0'.repeat(64)

/**
 * @param {string[]} eventIds 本批归档 message eventId
 * @returns {string[]} 规范化排序 id
 */
export function normalizeSealEventIds(eventIds) {
	return [...new Set(eventIds.map(id => String(id).trim().toLowerCase()).filter(isHex64))].sort()
}

/**
 * @param {object} seal 封口记录
 * @returns {object} 参与签名的 canonical 体
 */
export function sealSignBody(seal) {
	/** @type {Record<string, unknown>} */
	const body = {
		groupId: String(seal.groupId || ''),
		channelId: String(seal.channelId || ''),
		throughEventId: String(seal.throughEventId || '').trim().toLowerCase(),
		merkleRoot: String(seal.merkleRoot || '').trim().toLowerCase(),
		sealedAt: Number(seal.sealedAt) || 0,
	}
	if (seal.prevSealHash != null) {
		const prev = String(seal.prevSealHash || '').trim().toLowerCase()
		if (isHex64(prev)) body.prevSealHash = prev
	}
	return body
}

/**
 * @param {object} seal 封口记录
 * @returns {string} 64 hex 签名体 hash
 */
export function hashSealSignBody(seal) {
	return createHash('sha256').update(canonicalStringify(sealSignBody(seal)), 'utf8').digest('hex')
}

/**
 * @param {object | null | undefined} previousSeal 上一条 seal
 * @returns {string} 下一条 seal 应使用的 prevSealHash
 */
export function computePrevSealHashFromStoredSeal(previousSeal) {
	if (!previousSeal) return GENESIS_PREV_SEAL_HASH
	return hashSealSignBody(previousSeal)
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
	const messageBytes = Buffer.from(canonicalStringify(sealSignBody(seal)), 'utf8')
	return verify(Buffer.from(raw, 'hex'), messageBytes, ownerPublicKey)
}

/**
 * @param {object} state 物化群状态
 * @param {object} seal 封口
 * @returns {Promise<boolean>} 是否任一 checkpoint signer 验签通过
 */
async function verifyArchiveSealAgainstSigners(state, seal) {
	const signers = checkpointSignerPubKeyHashes(state)
	for (const senderHash of signers) {
		const pubHex = state.members?.[senderHash]?.pubKeyHex
		if (!pubHex || !/^[\da-f]{64}$/iu.test(pubHex)) continue
		if (await verifyArchiveSeal(seal, new Uint8Array(Buffer.from(pubHex, 'hex'))))
			return true
	}
	return false
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} seal 封口
 * @returns {Promise<boolean>} 验签是否通过
 */
export async function validateArchiveSealForGroup(username, groupId, seal) {
	if (!seal) return false
	const checkpoint = await safeReadJson(snapshotPath(username, groupId))
	if (!checkpoint?.members_record) return false
	const state = materializeFromCheckpoint(checkpoint)
	return verifyArchiveSealAgainstSigners(state, seal)
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道
 * @param {object} seal 待验 seal
 * @param {object | null | undefined} localSeal 本地已有 seal
 * @returns {Promise<boolean>} 链 + 签名是否有效
 */
export async function assertArchiveSealChainValid(username, groupId, channelId, seal, localSeal = null) {
	if (!seal) return true
	if (String(seal.channelId || '') !== channelId) return false
	if (!await validateArchiveSealForGroup(username, groupId, seal)) return false
	if (seal.prevSealHash == null) return true
	const expectedPrev = computePrevSealHashFromStoredSeal(localSeal || null)
	return String(seal.prevSealHash || '').trim().toLowerCase() === expectedPrev
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

	const manifest = await loadArchiveManifest(username, groupId)
	const previousSeal = manifest.seals?.[channelId] || null
	const prevSealHash = computePrevSealHashFromStoredSeal(previousSeal)

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
		prevSealHash,
	}
	const ownerSignature = await signSealPayload(payload, secretKey)
	const seal = { ...payload, ownerSignature, eventCount: ids.length }
	if (!await verifyArchiveSeal(seal, derived)) return null

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
