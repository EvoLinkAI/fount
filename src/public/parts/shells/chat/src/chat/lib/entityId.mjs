/**
 * 【文件】src/chat/lib/entityId.mjs
 * 【职责】实体 ID 派生：由 nodeHash 与 part URI 计算 agent/user entityHash。
 * 【原理】SHA-256 截断 128bit；缓存常用 chars/personas 映射。
 * 【数据结构】EntityHash：32 hex chars；PartUri：如 chars/foo。
 * 【关联】lib/nodeHash、profile/agentResolve、public lib/entityId。
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { pubKeyHash } from '../../../../../../../scripts/p2p/crypto.mjs'
import { isHex64, normalizeHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'

/** 128 位小写 hex：`nodeHash(64)` + `subjectHash(64)`。 */
export const ENTITY_HASH_RE = /^[\da-f]{128}$/u

const AGENT_SUBJECT_PREFIX = 'fount:chat:agent:'

/**
 * @param {unknown} pubKeyHex 32 字节公钥 hex
 * @returns {string} 64 位 nodeHash / subjectHash（pubKeyHash）
 */
export function hashFromPubKeyHex(pubKeyHex) {
	const hex = normalizeHex64(pubKeyHex)
	if (!isHex64(hex) || Buffer.from(hex, 'hex').length !== 32)
		throw new Error('invalid pubKeyHex')
	return pubKeyHash(Buffer.from(hex, 'hex'))
}

/**
 * @param {string} charPartPath 角色 part 路径，如 `chars/MyChar`
 * @returns {string} 64 位 agent subjectHash
 */
export function agentSubjectHash(charPartPath) {
	const slug = String(charPartPath || '').trim().replace(/^\/+/, '').replace(/\\/g, '/')
	return createHash('sha256').update(`${AGENT_SUBJECT_PREFIX}${slug}`, 'utf8').digest('hex')
}

/**
 * @param {string} nodeHash 所属节点（64 hex）
 * @param {string} subjectHash 主体（用户签名公钥 hash 或 agent subjectHash）
 * @returns {string} 128 位 entityHash
 */
export function encodeEntityHash(nodeHash, subjectHash) {
	const node = normalizeHex64(nodeHash)
	const subject = normalizeHex64(subjectHash)
	if (!isHex64(node) || !isHex64(subject))
		throw new Error('invalid entity hash parts')
	return node + subject
}

/**
 * @param {unknown} entityHash 128 位 entityHash
 * @returns {{ entityHash: string, nodeHash: string, subjectHash: string } | null} 解析结果
 */
export function parseEntityHash(entityHash) {
	const raw = String(entityHash ?? '').trim().toLowerCase().replace(/^0x/iu, '')
	if (!ENTITY_HASH_RE.test(raw)) return null
	return {
		entityHash: raw,
		nodeHash: raw.slice(0, 64),
		subjectHash: raw.slice(64, 128),
	}
}

/**
 * @param {unknown} value 待校验值
 * @returns {boolean} 是否为合法 entityHash
 */
export function isEntityHash128(value) {
	return ENTITY_HASH_RE.test(String(value ?? '').trim().toLowerCase().replace(/^0x/iu, ''))
}

/**
 * @param {string} nodeHash 节点 hash
 * @param {string} charPartPath 角色 part 路径
 * @returns {string} agent entityHash
 */
export function agentEntityHash(nodeHash, charPartPath) {
	return encodeEntityHash(nodeHash, agentSubjectHash(charPartPath))
}

/**
 * @param {string} nodeHash 成员所属节点 hash
 * @param {string} pubKeyHex 32 字节公钥 hex（如 identityPubKeyHex）
 * @returns {string} user entityHash
 */
export function userEntityHashFromPubKeyHex(nodeHash, pubKeyHex) {
	return encodeEntityHash(nodeHash, hashFromPubKeyHex(pubKeyHex))
}

/**
 * @param {string} nodeHash 成员所属节点 hash
 * @param {string} subjectHash 成员签名 pubKeyHash（DAG sender）
 * @returns {string} user entityHash
 */
export function userEntityHashFromSubjectHash(nodeHash, subjectHash) {
	const subject = normalizeHex64(subjectHash)
	if (!isHex64(subject)) throw new Error('invalid subject hash')
	return encodeEntityHash(nodeHash, subject)
}

/**
 * @param {object} member 物化成员行
 * @param {string} [member.pubKeyHash] 成员签名公钥 hash
 * @param {string} [member.homeNodeHash] 所属节点 hash
 * @returns {string | null} entityHash；无 pubKeyHash 时为 null
 */
export function memberEntityHash(member) {
	const subject = normalizeHex64(member?.pubKeyHash || '')
	const node = normalizeHex64(member?.homeNodeHash || '')
	if (!isHex64(subject) || !isHex64(node)) return null
	return encodeEntityHash(node, subject)
}
