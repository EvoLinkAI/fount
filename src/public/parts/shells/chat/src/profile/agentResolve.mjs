/**
 * 【文件】profile/agentResolve.mjs
 * 【职责】将 agent 的 entityHash 反查为本机 chars 目录下的角色 part 名。
 * 【原理】解析 entityHash 得 nodeHash+subjectHash；校验 nodeHash 为本机后遍历 chars/ 比对 agentEntityHash。
 * 【数据结构】128 位 entityHash、partPath（chars/<name>）、replica 用户字典路径。
 * 【关联】被 profile/localized.mjs 解析 agent 展示名时调用；依赖 entityId.mjs、replica.mjs。
 */
import fs from 'node:fs'
import path from 'node:path'

import { getUserDictionary } from '../../../../../../server/auth.mjs'
import { agentEntityHash, parseEntityHash } from '../chat/lib/entityId.mjs'
import { getLocalNodeHash } from '../chat/lib/replica.mjs'

/**
 * @param {string} replicaUsername replica 所有者
 * @param {string} entityHash 128 位 agent entityHash
 * @returns {string | null} 角色 part 名（`chars/` 下目录名）
 */
export function resolveAgentCharPartName(replicaUsername, entityHash) {
	const parsed = parseEntityHash(entityHash)
	if (!parsed) return null
	const nodeHash = getLocalNodeHash()
	if (parsed.nodeHash !== nodeHash) return null
	const charsRoot = path.join(getUserDictionary(replicaUsername), 'chars')
	if (!fs.existsSync(charsRoot)) return null
	for (const ent of fs.readdirSync(charsRoot, { withFileTypes: true })) {
		if (!ent.isDirectory()) continue
		const partPath = `chars/${ent.name}`
		if (agentEntityHash(nodeHash, partPath) === parsed.entityHash)
			return ent.name
	}
	return null
}
