/**
 * 【文件】files/chunkRefcount.mjs
 * 【职责】本节点 per-group 分块本地引用计数与 lastAccess 时间（§10.4），供 GC/LRU 决策。
 * 【原理】chunk_local_refcount.json 原子写；bump/release 按 storageLocator 增减。
 * 【数据结构】{ refs: Record<locator, number>, lastAccess: Record<locator, ms> }。
 * 【关联】groupFiles release、chunkLruEvict；paths groupDir。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeJsonAtomic } from '../dag/storage.mjs'
import { groupDir } from '../lib/paths.mjs'


/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {string} `chunk_local_refcount.json` 路径
 */
function refcountPath(username, groupId) {
	return join(groupDir(username, groupId), 'chunk_local_refcount.json')
}

/**
 * @param {unknown} raw 磁盘 JSON
 * @returns {{ refs: Record<string, number>, lastAccess: Record<string, number> }} 引用与访问时间
 */
function parseRefcountStore(raw) {
	const empty = { refs: {}, lastAccess: {} }
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
	const store = /** @type {Record<string, unknown>} */ raw
	if (!store.refs || typeof store.refs !== 'object' || Array.isArray(store.refs)) return empty
	/** @type {Record<string, number>} */
	const refs = {}
	for (const [locator, count] of Object.entries(/** @type {Record<string, unknown>} */ store.refs)) {
		const referenceCount = Number(count)
		if (referenceCount > 0) refs[locator] = Math.floor(referenceCount)
	}
	/** @type {Record<string, number>} */
	const lastAccess = {}
	if (store.lastAccess && typeof store.lastAccess === 'object' && !Array.isArray(store.lastAccess))
		for (const [locator, timestamp] of Object.entries(/** @type {Record<string, unknown>} */ store.lastAccess)) {
			const accessTime = Number(timestamp)
			if (accessTime > 0) lastAccess[locator] = Math.floor(accessTime)
		}
	return { refs, lastAccess }
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {Promise<Record<string, number>>} locator → 引用计数
 */
export async function loadChunkRefcounts(username, groupId) {
	try {
		return parseRefcountStore(JSON.parse(await readFile(refcountPath(username, groupId), 'utf8'))).refs
	}
	catch {
		return {}
	}
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @returns {Promise<{ refs: Record<string, number>, lastAccess: Record<string, number> }>} 完整表
 */
export async function loadChunkRefcountStore(username, groupId) {
	try {
		return parseRefcountStore(JSON.parse(await readFile(refcountPath(username, groupId), 'utf8')))
	}
	catch {
		return { refs: {}, lastAccess: {} }
	}
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {{ refs: Record<string, number>, lastAccess: Record<string, number> }} store 存储结构
 * @returns {Promise<void>}
 */
async function saveChunkRefcountStore(username, groupId, store) {
	const path = refcountPath(username, groupId)
	await mkdir(dirname(path), { recursive: true })
	await writeJsonAtomic(path, store)
}

/**
 * 本节点持有分块时 +1（§10.4 本地视角）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} storageLocator 定位符
 * @returns {Promise<void>}
 */
export async function bumpChunkLocalRef(username, groupId, storageLocator) {
	const locator = String(storageLocator || '').trim()
	if (!locator) return
	const store = await loadChunkRefcountStore(username, groupId)
	store.refs[locator] = (store.refs[locator] || 0) + 1
	store.lastAccess[locator] = Date.now()
	await saveChunkRefcountStore(username, groupId, store)
}

/**
 * 记录分块被读取（LRU 辅助，§10.4）。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} storageLocator 定位符
 * @returns {Promise<void>}
 */
export async function touchChunkLocalAccess(username, groupId, storageLocator) {
	const locator = String(storageLocator || '').trim()
	if (!locator) return
	const store = await loadChunkRefcountStore(username, groupId)
	if (!store.refs[locator]) return
	store.lastAccess[locator] = Date.now()
	await saveChunkRefcountStore(username, groupId, store)
}

/**
 * 引用归零后返回 true，调用方可物理删块。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} storageLocator 定位符
 * @returns {Promise<boolean>} 归零则为 true
 */
export async function releaseChunkLocalRef(username, groupId, storageLocator) {
	const locator = String(storageLocator || '').trim()
	if (!locator) return false
	const store = await loadChunkRefcountStore(username, groupId)
	const nextCount = (store.refs[locator] || 0) - 1
	if (nextCount <= 0) {
		delete store.refs[locator]
		delete store.lastAccess[locator]
		await saveChunkRefcountStore(username, groupId, store)
		return true
	}
	store.refs[locator] = nextCount
	await saveChunkRefcountStore(username, groupId, store)
	return false
}
