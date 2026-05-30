/**
 * 【文件】files/attachmentRefs.mjs
 * 【职责】从 DAG、物化索引、context sidecar 与内存 chatLog 收集 `file:{hash}` 可达引用（§6 附件 GC 根）。
 * 【原理】collectFileRefHashesFromValue 递归 JSON；遍历 events/quarantine/messages；与 blob refcount 对账删孤儿 blob。联邦分块与 blob 仓分离，此处只管 file: 逻辑附件 hash。
 * 【数据结构】Set<string> 引用 hash；FILE_REF_PREFIX=`file:`。
 * 【关联】blobStore、contextSidecar、session/wsLifecycle groupMetadatas；groupFiles、channel/postMessage。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { loadJsonFile } from '../../../../../../../scripts/json_loader.mjs'
import { parseEvfsRef } from '../../../../../../../scripts/p2p/entity/files/evfs_ref.mjs'
import { readJsonl } from '../dag/storage.mjs'
import { groupDir, eventsPath, quarantinePath } from '../lib/paths.mjs'
import { listUserGroups } from '../lib/userGroups.mjs'
import { isEnoent, rethrowUnlessEnoentOrEnotdir } from '../lib/utils.mjs'
import { groupMetadatas } from '../session/wsLifecycle.mjs'


/**
 * @param {unknown} value JSON 子树
 * @param {Set<string>} referenced 就地写入的 hash 集合
 * @param {Set<string>} evfsPaths EVFS 逻辑路径 entityHash/logicalPath
 * @returns {void}
 */
export function collectFileRefHashesFromValue(value, referenced, evfsPaths) {
	if (typeof value === 'string') {
		const parsed = parseEvfsRef(value)
		if (parsed) evfsPaths.add(`${parsed.entityHash}/${parsed.logicalPath}`)
		if (value.includes('/api/p2p/entities/') && value.includes('/files/')) {
			const m = value.match(/\/api\/p2p\/entities\/([\da-f]{128})\/files\/(.+?)(?:\?|$)/iu)
			if (m) evfsPaths.add(`${m[1].toLowerCase()}/${decodeURIComponent(m[2])}`)
		}
		return
	}
	if (!value || typeof value !== 'object') return
	if (Array.isArray(value)) {
		for (const item of value) collectFileRefHashesFromValue(item, referenced, evfsPaths)
		return
	}
	for (const key of Object.keys(value))
		collectFileRefHashesFromValue(value[key], referenced, evfsPaths)
}

/**
 * @param {object} entry 聊天日志条目或侧车上下文行
 * @param {Set<string>} referenced hash 集合
 * @param {Set<string>} evfsPaths EVFS 路径
 * @returns {void}
 */
function collectFromChatLogEntry(entry, referenced, evfsPaths) {
	if (!entry) return
	for (const file of entry.files || []) {
		const buffer = file?.buffer
		if (typeof buffer === 'string') {
			const parsed = parseEvfsRef(buffer)
			if (parsed) evfsPaths.add(`${parsed.entityHash}/${parsed.logicalPath}`)
		}
	}
	for (const contextEntry of entry.logContextBefore || [])
		collectFromChatLogEntry(contextEntry, referenced, evfsPaths)
	for (const contextEntry of entry.logContextAfter || [])
		collectFromChatLogEntry(contextEntry, referenced, evfsPaths)
}

/**
 * @param {string} username replica 所有者
 * @param {Set<string>} referenced hash 集合
 * @param {Set<string>} evfsPaths EVFS 路径
 * @returns {void}
 */
function collectFromRuntimeChatMetadatas(username, referenced, evfsPaths) {
	for (const [, slot] of groupMetadatas) {
		if (slot.username !== username || !slot.chatMetadata) continue
		for (const entry of slot.chatMetadata.chatLog)
			collectFromChatLogEntry(entry, referenced, evfsPaths)
	}
}

/**
 * @param {object[]} lines JSONL 行
 * @param {Set<string>} referenced hash 集合
 * @param {Set<string>} evfsPaths EVFS 路径
 * @returns {void}
 */
function collectFromDagJsonlLines(lines, referenced, evfsPaths) {
	const deleted = new Set()
	for (const line of lines)
		if (line.type === 'message_delete' && line.content?.targetId)
			deleted.add(String(line.content.targetId))


	for (const line of lines) {
		if (line.type === 'message') {
			const messageId = line.eventId || line.id
			if (messageId && deleted.has(String(messageId))) continue
		}
		else if (line.type === 'message_edit') {
			const targetId = line.content?.targetId
			if (targetId && deleted.has(String(targetId))) continue
		}
		else if (line.type === 'message_delete')
			continue

		collectFileRefHashesFromValue(line, referenced, evfsPaths)
	}
}

/**
 * @param {string} username 本地账户名
 * @param {string} groupId 群 ID
 * @param {Set<string>} referenced hash 集合
 * @param {Set<string>} evfsPaths EVFS 路径
 * @returns {Promise<void>}
 */
async function scanGroupContextCache(username, groupId, referenced, evfsPaths) {
	const contextCacheRoot = join(groupDir(username, groupId), 'context_cache')
	let channelDirNames = []
	try {
		channelDirNames = await readdir(contextCacheRoot)
	}
	catch (error) {
		if (isEnoent(error)) return
		throw error
	}

	for (const channelDirName of channelDirNames) {
		const channelPath = join(contextCacheRoot, channelDirName)
		let sidecarNames = []
		try {
			sidecarNames = await readdir(channelPath)
		}
		catch (error) {
			if (isEnoent(error)) continue
			throw error
		}
		for (const name of sidecarNames) {
			if (!name.endsWith('.json')) continue
			const data = loadJsonFile(join(channelPath, name))
			collectFileRefHashesFromValue(data, referenced, evfsPaths)
		}
	}
}

/**
 * @param {string} username 本地账户名
 * @param {string} groupId 群 ID
 * @param {Set<string>} referenced hash 集合
 * @param {Set<string>} evfsPaths EVFS 路径 entityHash/logicalPath
 * @returns {Promise<void>}
 */
async function scanGroupDagStores(username, groupId, referenced, evfsPaths) {
	const messagesDir = join(groupDir(username, groupId), 'messages')
	let indexFilenames = []
	try {
		indexFilenames = await readdir(messagesDir)
	}
	catch (error) {
		rethrowUnlessEnoentOrEnotdir(error)
	}
	for (const name of indexFilenames) {
		if (!name.endsWith('.jsonl')) continue
		const lines = await readJsonl(join(messagesDir, name))
		collectFromDagJsonlLines(lines, referenced, evfsPaths)
	}

	const eventLines = await readJsonl(eventsPath(username, groupId))
	collectFromDagJsonlLines(eventLines, referenced, evfsPaths)

	const quarantineLines = await readJsonl(quarantinePath(username, groupId))
	collectFromDagJsonlLines(quarantineLines, referenced, evfsPaths)

	await scanGroupContextCache(username, groupId, referenced, evfsPaths)
}

/**
 * 汇总本用户仍被引用的 legacy 附件 hash。
 * @param {string} username 本地账户名
 * @returns {Promise<Set<string>>} 引用中的 blake2b 文件名（无扩展名）
 */
export async function collectReferencedAttachmentHashes(username) {
	/** @type {Set<string>} */
	const referenced = new Set()
	/** @type {Set<string>} */
	const evfsPaths = new Set()

	collectFromRuntimeChatMetadatas(username, referenced, evfsPaths)

	for (const groupId of await listUserGroups(username))
		await scanGroupDagStores(username, groupId, referenced, evfsPaths)

	return referenced
}

/**
 * 汇总仍被引用的 EVFS 路径（entityHash/logicalPath）。
 * @param {string} username 本地账户名
 * @returns {Promise<Set<string>>} entityHash/logicalPath 集合
 */
export async function collectReferencedEvfsPaths(username) {
	/** @type {Set<string>} */
	const referenced = new Set()
	/** @type {Set<string>} */
	const evfsPaths = new Set()

	collectFromRuntimeChatMetadatas(username, referenced, evfsPaths)

	for (const groupId of await listUserGroups(username))
		await scanGroupDagStores(username, groupId, referenced, evfsPaths)

	return evfsPaths
}
