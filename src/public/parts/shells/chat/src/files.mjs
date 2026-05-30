/**
 * 【文件】src/files.mjs
 * 【职责】管理用户级聊天附件的 content-addressed 存储（blake2b 哈希文件名）及周期性孤儿文件回收。
 * 【原理】addFile 对用户目录 `shells/chat/files/<hash>` 去重写入；getFile 同步读回；gcOrphanAttachments 通过 collectReferencedAttachmentHashes 汇总 DAG/sidecar/runtime 引用集后删除磁盘上未引用文件；cleanFiles 每小时遍历全用户，main Unload 引用归零时 clearInterval。
 * 【数据结构】hash（hex 摘要）、getUserDir(username) 路径、referenced Set、cleanFilesInterval 定时器句柄。
 * 【关联】被 src/endpoints.mjs 附件 POST/GET 与 main Unload 使用；import chat/files/attachmentRefs.mjs 收集引用。
 */
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { setInterval } from 'node:timers'

import blake2b from 'npm:@bitgo/blake2b-wasm'
import { on_shutdown } from 'npm:on-shutdown'

import { ms } from '../../../../../scripts/ms.mjs'
import { nicerWriteFileSync } from '../../../../../scripts/nicerWriteFile.mjs'
import { getAllUserNames, getUserDictionary } from '../../../../../server/auth.mjs'

import { collectReferencedAttachmentHashes } from './chat/files/attachmentRefs.mjs'

/**
 * 获取buffer的hash值。
 * @param {Buffer} buffer - 输入的buffer。
 * @returns {Promise<string>} - hash值。
 */
async function getHash(buffer) {
	return new Promise((resolve, reject) => {
		blake2b.ready(function (err) {
			if (err) return reject(err)
			resolve(
				blake2b()
					.update(Buffer.from(buffer))
					.digest('hex')
			)
		})
	})
}

/**
 * @param {string} username - 用户名。
 * @returns {string} - 用户目录路径。
 */
function getUserDir(username) { return getUserDictionary(username) + '/shells/chat/files/' }

/**
 * 添加文件。
 * @param {string} username - 用户名。
 * @param {Buffer} buffer - 文件buffer。
 * @returns {Promise<string>} - 文件hash。
 */
export async function addFile(username, buffer) {
	const hash = await getHash(buffer)
	const userDir = getUserDir(username)
	if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true })
	nicerWriteFileSync(userDir + hash, buffer)
	return hash
}

/**
 * 获取文件。
 * @param {string} username - 用户名。
 * @param {string} hash - 文件hash。
 * @returns {Buffer} - 文件buffer。
 */
export function getFile(username, hash) {
	return fs.readFileSync(getUserDir(username) + hash)
}

/**
 * 删除 `shells/chat/files/` 下未被 DAG / sidecar / 活跃 runtime 引用的附件。
 * @param {string} username 本地账户名
 * @returns {Promise<void>}
 */
export async function gcOrphanAttachments(username) {
	const userDir = getUserDir(username)
	if (!fs.existsSync(userDir)) return

	const referenced = await collectReferencedAttachmentHashes(username)
	for (const filename of fs.readdirSync(userDir)) 
		if (!referenced.has(filename))
			fs.unlinkSync(userDir + filename)
	
}

/**
 * @returns {Promise<void>}
 */
async function cleanFiles() {
	for (const username of getAllUserNames())
		await gcOrphanAttachments(username)
}

/**
 *
 */
export const cleanFilesInterval = setInterval(cleanFiles, ms('1h')).unref()
on_shutdown(cleanFiles)
