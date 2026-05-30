/**
 * 【文件】src/chat/lib/replica.mjs
 * 【职责】事件与分块副本追踪：记录哪些 peer 已同步哪些 hash。
 * 【原理】Map peerId→Set<hash>；gossip 时差集作为 want 列表。
 * 【数据结构】ReplicaMatrix：peerId → Set<eventId|contentHash>。
 * 【关联】federation/gossip、files/chunkReplicationAck、dag/syncScope。
 */
import { pubKeyHash, publicKeyFromSeed } from '../../../../../../../scripts/p2p/crypto.mjs'
import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'
import { getUserByReq } from '../../../../../../../server/auth.mjs'
import { readLocalSignerSeed } from '../dag/localSigner.mjs'
import { getFederationSettings } from '../federation/config.mjs'

import {
	encodeEntityHash,
	parseEntityHash,
	userEntityHashFromPubKeyHex,
} from './entityId.mjs'
import { nodeHashFromMac } from './nodeHash.mjs'

/** @returns {string} 本节点 nodeHash（由本机 MAC 种子派生） */
export function getLocalNodeHash() {
	return nodeHashFromMac()
}

/**
 * @param {string} replicaUsername replica 所有者
 * @returns {string | null} 本节点操作者 entityHash；未配置合法 identity 时为 null
 */
export function resolveOperatorEntityHash(replicaUsername) {
	const { identityPubKeyHex } = getFederationSettings(replicaUsername)
	if (!isHex64(identityPubKeyHex)) return null
	return userEntityHashFromPubKeyHex(getLocalNodeHash(), identityPubKeyHex)
}

/**
 * @param {string} replicaUsername replica 所有者
 * @returns {string} 本节点操作者默认 user entityHash（identity 密钥）
 */
export function getOperatorEntityHash(replicaUsername) {
	const entityHash = resolveOperatorEntityHash(replicaUsername)
	if (!entityHash)
		throw new Error('configure identityPubKeyHex in federation settings first')
	return entityHash
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} groupId 群 ID
 * @returns {Promise<string>} 本群成员 entityHash（local_signer_seed → subjectHash）
 */
export async function getGroupMemberEntityHash(replicaUsername, groupId) {
	const nodeHash = getLocalNodeHash()
	const seed = await readLocalSignerSeed(replicaUsername, groupId)
	const subjectHash = pubKeyHash(publicKeyFromSeed(seed))
	return encodeEntityHash(nodeHash, subjectHash)
}

/**
 * @param {import('npm:express').Request} req 已 authenticate 的请求
 * @returns {Promise<{ replicaUsername: string, nodeHash: string, operatorEntityHash: string | null }>} replica 上下文
 */
export async function getReplicaFromReq(req) {
	const { username: replicaUsername } = await getUserByReq(req)
	const nodeHash = getLocalNodeHash()
	return {
		replicaUsername,
		nodeHash,
		operatorEntityHash: resolveOperatorEntityHash(replicaUsername),
	}
}

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} entityHash 目标 entityHash
 * @returns {boolean} 是否为本 replica 可写实体（nodeHash 匹配本节点）
 */
export function isWritableLocalEntity(replicaUsername, entityHash) {
	const parsed = parseEntityHash(entityHash)
	if (!parsed) return false
	return parsed.nodeHash === getLocalNodeHash()
}
