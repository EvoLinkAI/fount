/**
 * 【文件】src/chat/lib/nodeHash.mjs
 * 【职责】用户节点哈希：从用户名与设备密钥派生稳定 nodeId/nodeHash。
 * 【原理】读用户密钥材料，SHA-256 导出 64/128 hex；全局缓存 per username。
 * 【数据结构】NodeHash：64 hex；NodeId：联邦对等端标识。
 * 【关联】dag/localSigner、federation/deps、profile/agentResolve。
 */
/* global Deno */
import { createHash } from 'node:crypto'

import { keyPairFromSeed, pubKeyHash } from '../../../../../../../scripts/p2p/crypto.mjs'

const MAC_NODE_SEED_PREFIX = 'fount:chat:node:mac:'

/**
 * 选取本机主网卡 MAC（排除全零；按接口名排序取首个，结果稳定）。
 * @returns {string} 12 位小写 hex（无分隔符）
 */
export function pickPrimaryMacHex() {
	const candidates = []
	for (const iface of Deno.networkInterfaces()) {
		const mac = String(iface.mac || '').trim().toLowerCase()
		if (!mac || mac === '00:00:00:00:00:00') continue
		candidates.push({
			name: String(iface.name || ''),
			mac: mac.replace(/[^a-f0-9]/g, ''),
		})
	}
	candidates.sort((a, b) => a.name.localeCompare(b.name))
	if (!candidates.length || candidates[0].mac.length < 12)
		throw new Error('no usable MAC address for nodeHash')
	return candidates[0].mac
}

/**
 * 由 MAC 派生节点 hash（64 hex，与 pubKeyHash 格式一致）。
 * @returns {string} nodeHash
 */
export function nodeHashFromMac() {
	const mac = pickPrimaryMacHex()
	const seed = createHash('sha256').update(`${MAC_NODE_SEED_PREFIX}${mac}`, 'utf8').digest()
	const { publicKey } = keyPairFromSeed(seed)
	return pubKeyHash(publicKey)
}
