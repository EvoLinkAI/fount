/**
 * 【文件】public/src/files.mjs
 * 【职责】聊天附件上传与按 hash 下载（multipart → BLAKE2b file: 引用）。
 * 【原理】uploadChatAttachment FormData POST；getFile 拉取二进制供预览。
 * 【数据结构】file:hash 字符串、File/Blob。
 * 【关联】composerAttachments.mjs；后端 files GC 与存储。
 */
/**
 * 上传聊天附件（multipart → BLAKE2b hash）。
 * @param {File | Blob} file 文件
 * @param {string} [fieldName] 表单字段名
 * @returns {Promise<string>} `file:` 引用用的 hash
 */
export async function uploadChatAttachment(file, fieldName = 'file') {
	const body = new FormData()
	body.append(fieldName, file)
	const res = await fetch('/api/parts/shells:chat/attachments', {
		method: 'POST',
		credentials: 'include',
		body,
	})
	if (!res.ok) {
		const data = await res.json().catch(() => ({}))
		throw new Error(data.error || `attachment upload failed: ${res.status}`)
	}
	const data = await res.json()
	const hash = Array.isArray(data.hashes) ? data.hashes[0] : data.hash
	if (!hash || typeof hash !== 'string') throw new Error('attachment upload: missing hash')
	return hash
}

/**
 * 获取文件。
 * @param {string} hash - 文件哈希或 `file:` 前缀引用。
 * @returns {Promise<ArrayBuffer>} - 文件内容。
 */
export async function getFile(hash) {
	if (hash.startsWith('file:')) hash = hash.slice(5)
	const res = await fetch('/api/parts/shells:chat/attachments/' + encodeURIComponent(hash), { credentials: 'include' })
	if (!res.ok) throw new Error(`attachment fetch failed: ${res.status}`)
	return res.arrayBuffer()
}
