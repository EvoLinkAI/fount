import { readFile, writeFile, mkdir } from 'node:fs/promises'

import { getAllUserNames } from '../../../../../server/auth.mjs'

import { followingPath } from './paths.mjs'

/**
 * 读取用户关注列表。
 * @param {string} username 用户
 * @returns {Promise<{ following: string[], updatedAt: number }>} 关注列表与更新时间
 */
export async function loadFollowing(username) {
	try {
		const storedData = JSON.parse(await readFile(followingPath(username), 'utf8'))
		return {
			following: Array.isArray(storedData.following)
				? storedData.following.map(id => String(id).toLowerCase())
				: [],
			updatedAt: Number(storedData.updatedAt) || 0,
		}
	}
	catch {
		return { following: [], updatedAt: 0 }
	}
}

/**
 * 持久化关注列表。
 * @param {string} username 用户
 * @param {string[]} following entityHash 列表
 * @returns {Promise<string[]>} 规范化后的关注列表
 */
export async function saveFollowing(username, following) {
	await mkdir(`${followingPath(username).replace(/[/\\][^/\\]+$/, '')}`, { recursive: true })
	const normalized = [...new Set(following.map(id => String(id).toLowerCase()))]
	await writeFile(followingPath(username), JSON.stringify({
		following: normalized,
		updatedAt: Date.now(),
	}, null, '\t'), 'utf8')
	return normalized
}

/**
 * 关注或取关指定 entityHash。
 * @param {string} username 用户
 * @param {string} entityHash 目标
 * @param {boolean} follow true=关注 false=取关
 * @returns {Promise<string[]>} 规范化后的关注列表
 */
export async function setFollow(username, entityHash, follow) {
	const current = await loadFollowing(username)
	const id = String(entityHash).toLowerCase()
	const set = new Set(current.following)
	if (follow) set.add(id)
	else set.delete(id)
	return saveFollowing(username, [...set])
}

/**
 * 哪些 replica 在关注列表中包含该 entityHash（用于 OnFollowerUpdate 分发）。
 * @param {string} entityHash 被关注实体
 * @returns {Promise<string[]>} replica 登录名列表
 */
export async function listReplicaUsernamesFollowing(entityHash) {
	const target = String(entityHash || '').toLowerCase()
	if (!target) return []
	/** @type {string[]} */
	const replicas = []
	for (const username of getAllUserNames()) {
		const { following } = await loadFollowing(username)
		if (following.includes(target)) replicas.push(username)
	}
	return replicas
}
