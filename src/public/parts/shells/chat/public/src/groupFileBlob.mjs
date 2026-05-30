/**
 * 【文件】public/src/groupFileBlob.mjs
 * 【职责】群加密文件解密下载：联邦分块密文 → Blob URL。
 * 【原理】fetchDecryptedGroupBlob 按 meta 拉块并解密；fetchGroupFileAsBlobUrl 封装 fileId 路径。
 * 【数据结构】meta { fileId, chunks, key hints }；Uint8Array 明文。
 * 【关联】ui/groupFileUpload.mjs、federationUpload.mjs；群文件系统 API。
 */
import { isHex64 } from './lib/pubKeyHex.mjs'

/**
 * @param {string} b64 base64 明文
 * @returns {Uint8Array} 字节
 */
function b64PlainToU8(b64) {
	const bin = atob(b64)
	const bytes = new Uint8Array(bin.length)
	for (let byteIndex = 0; byteIndex < bin.length; byteIndex++)
		bytes[byteIndex] = bin.charCodeAt(byteIndex)
	return bytes
}

/**
 * 拉取并解密群文件（单块或 `parts[]`，§10.3）。
 * @param {string} groupId 群 ID
 * @param {object} meta 文件元数据（含 `uploaderPubKeyHash`）
 * @returns {Promise<Uint8Array | null>} 明文或 null
 */
export async function fetchDecryptedGroupBlob(groupId, meta) {
	const blame = isHex64(meta.uploaderPubKeyHash)
		? meta.uploaderPubKeyHash
		: ''
	if (Array.isArray(meta.parts) && meta.parts.length) {
		const sorted = [...meta.parts].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
		const slices = []
		for (const part of sorted) {
			const q = new URLSearchParams({
				locator: part.storageLocator,
				content_hash: part.contentHash,
			})
			if (blame) q.set('blame_pub_key', blame)
			const r = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(groupId)}/chunks?${q}`)
			if (!r.ok) return null
			const body = await r.json()
			if (!body?.data) return null
			slices.push(b64PlainToU8(body.data))
		}
		const total = Number(meta.size) || slices.reduce((n, u8) => n + u8.byteLength, 0)
		const out = new Uint8Array(total)
		let off = 0
		for (const u8 of slices) {
			out.set(u8, off)
			off += u8.byteLength
		}
		return out
	}
	const q = new URLSearchParams({
		locator: meta.storageLocator,
		content_hash: meta.contentHash,
	})
	if (blame) q.set('blame_pub_key', blame)
	const r = await fetch(`/api/parts/shells:chat/groups/${encodeURIComponent(groupId)}/chunks?${q}`)
	if (!r.ok) return null
	const body = await r.json()
	if (!body?.data) return null
	return b64PlainToU8(body.data)
}

/**
 * 获取并解密群文件，返回 Blob URL（供 Hub 内联渲染）。
 * @param {string} groupId 群 ID
 * @param {string} fileId 文件 ID
 * @returns {Promise<string | null>} Blob URL；失败时为 null
 */
export async function fetchGroupFileAsBlobUrl(groupId, fileId) {
	const metaR = await fetch(
		`/api/parts/shells:chat/groups/${encodeURIComponent(groupId)}/files/${encodeURIComponent(fileId)}/meta`,
		{ credentials: 'include' },
	)
	if (!metaR.ok) return null
	const meta = await metaR.json()
	const hasParts = Array.isArray(meta.parts) && meta.parts.length
	if (!meta.contentHash || (!hasParts && !meta.storageLocator)) return null
	const plain = await fetchDecryptedGroupBlob(groupId, meta)
	if (!plain) return null
	return URL.createObjectURL(new Blob([plain], { type: meta.mimeType || 'application/octet-stream' }))
}
