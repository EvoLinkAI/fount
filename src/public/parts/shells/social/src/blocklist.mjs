import { readFile, writeFile, mkdir } from 'node:fs/promises'

import { blocklistPath } from './paths.mjs'

/**
 * 读取用户拉黑列表。
 * @param {string} username 用户
 * @returns {Promise<{ blocked: string[] }>} 拉黑 entityHash 列表
 */
export async function loadSocialBlocklist(username) {
	try {
		const raw = JSON.parse(await readFile(blocklistPath(username), 'utf8'))
		return {
			blocked: Array.isArray(raw.blocked)
				? raw.blocked.map(id => String(id).toLowerCase())
				: [],
		}
	}
	catch {
		return { blocked: [] }
	}
}

/**
 * 持久化拉黑列表。
 * @param {string} username 用户
 * @param {string[]} blocked entityHash 列表
 * @returns {Promise<string[]>} 规范化后的拉黑列表
 */
export async function saveSocialBlocklist(username, blocked) {
	await mkdir(`${blocklistPath(username).replace(/[/\\][^/\\]+$/, '')}`, { recursive: true })
	const normalized = [...new Set(blocked.map(id => String(id).toLowerCase()))]
	await writeFile(blocklistPath(username), JSON.stringify({ blocked: normalized }, null, '\t'), 'utf8')
	return normalized
}

/**
 * 拉黑或取消拉黑指定 entityHash。
 * @param {string} username 用户
 * @param {string} entityHash 目标
 * @param {boolean} block true=拉黑
 * @returns {Promise<string[]>} 规范化后的拉黑列表
 */
export async function setBlock(username, entityHash, block) {
	const current = await loadSocialBlocklist(username)
	const id = String(entityHash).toLowerCase()
	const set = new Set(current.blocked)
	if (block) set.add(id)
	else set.delete(id)
	return saveSocialBlocklist(username, [...set])
}

/**
 * 判断作者是否在当前用户拉黑列表中。
 * @param {string} username 用户
 * @param {string} entityHash 作者
 * @returns {Promise<boolean>} 是否被拉黑
 */
export async function isBlocked(username, entityHash) {
	const { blocked } = await loadSocialBlocklist(username)
	return blocked.includes(String(entityHash).toLowerCase())
}
