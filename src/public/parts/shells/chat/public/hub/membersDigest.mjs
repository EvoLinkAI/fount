/**
 * 【文件】public/hub/membersDigest.mjs
 * 【职责】成员列表 Merkle 摘要：为联邦成员同步计算活跃成员公钥哈希根。
 * 【原理】不直接操作 DOM；供联邦设置或成员校验流程读取摘要结果。
 * 【数据结构】见函数入参与返回值 JSDoc。
 * 【关联】../src/lib/pubKeyHex
 */
import { isHex64 } from '../src/lib/pubKeyHex.mjs'

/**
 * 浏览器端活跃成员 Merkle 根（与 `scripts/p2p/dag/index.mjs` `merkleRoot` 一致，§7.2）。
 */

/**
 * @param {string | Uint8Array} data UTF-8 文本或原始字节
 * @returns {Promise<Uint8Array>} SHA-256 摘要
 */
async function sha256(data) {
	const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data)
	return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

/**
 * @param {Uint8Array} left 左子摘要
 * @param {Uint8Array} right 右子摘要
 * @returns {Promise<Uint8Array>} 拼接后再哈希
 */
async function sha256Pair(left, right) {
	const buf = new Uint8Array(left.length + right.length)
	buf.set(left, 0)
	buf.set(right, left.length)
	return sha256(buf)
}

/**
 * @param {Uint8Array} digest 摘要字节
 * @returns {string} 小写 hex
 */
function digestHex(digest) {
	return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * @param {string[]} ids 成员 pubKeyHash（64 hex）
 * @returns {Promise<string>} Merkle 根 hex
 */
export async function computeMembersMerkleRoot(ids) {
	const sorted = [...new Set(ids.filter(isHex64))].sort()
	if (!sorted.length)
		return digestHex(await sha256(''))
	/** @type {Uint8Array[]} */
	let level = await Promise.all(sorted.map(sha256))
	while (level.length > 1) {
		/** @type {Uint8Array[]} */
		const next = []
		for (let index = 0; index < level.length; index += 2) {
			const left = level[index]
			const right = index + 1 < level.length ? level[index + 1] : left
			next.push(await sha256Pair(left, right))
		}
		level = next
	}
	return digestHex(level[0])
}

/**
 * 从群 state 的 `members` 数组提取与物化层一致的活跃成员键。
 * @param {Array<{ pubKeyHash?: string, username?: string }>} members 活跃成员
 * @returns {string[]} 64 位 hex pubKeyHash，已排序
 */
export function activeMemberPubKeyHashes(members) {
	return [...new Set((members || [])
		.map(member => String(member.pubKeyHash || member.memberId || '').trim().toLowerCase())
		.filter(isHex64))]
		.sort()
}

/**
 * 从 state 或分页 API 汇总活跃成员 pubKeyHash（多页时拉全部分页）。
 * @param {string} groupId 群 ID
 * @param {{ members?: object[], membersPagesCount?: number | null }} state 群 state
 * @param {(groupId: string, pageIdx: number) => Promise<{ members: object[] }>} fetchPage 分页拉取
 * @returns {Promise<string[]>} 已排序的 64 hex 哈希列表
 */
export async function collectActiveMemberHashes(groupId, state, fetchPage) {
	const pages = Math.max(1, Number(state?.membersPagesCount) || 1)
	if (pages <= 1)
		return activeMemberPubKeyHashes(state?.members)

	/** @type {object[]} */
	const merged = [...state?.members || []]
	for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
		const page = await fetchPage(groupId, pageIndex)
		for (const member of page.members || [])
			merged.push(member)
	}
	return activeMemberPubKeyHashes(merged)
}
