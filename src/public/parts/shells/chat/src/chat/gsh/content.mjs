/**
 * 【文件】src/chat/gsh/content.mjs
 * 【职责】GSH 内容编解码：压缩物化快照片段为可存储 blob。
 * 【原理】JSON patch + optional zstd；校验 checksum 后写入用户目录。
 * 【数据结构】GshBlob：version、patch、checksum。
 * 【关联】gsh/store、gsh/buffer、lib/jsonBoundary。
 */
/**
 * 【文件】gsh/content.mjs
 * 【职责】DAG 消息体 GSH 加解密（§11）：message/message_edit 的 content 加密后入联邦线，读盘/频道列表时按 generation 解密展示。
 * 【原理】encryptEventContent 用 getCurrentH；decryptEventContent 查 getHByGeneration，失败且代数超前则 buffer。密文信封 { gsh: { scheme, generation, iv, ciphertext, authTag } }。联邦中继的是密文，明文仅本机/授权成员可见。
 * 【数据结构】GSH_ENCRYPT_EVENT_TYPES Set；解密后的明文 content 对象。
 * 【关联】gsh/store.mjs、buffer.mjs、channel/postMessage、dag 物化、stream/auth 派生观看密钥。
 */
import { decryptMessage, encryptMessage } from '../../../../../../../scripts/p2p/gsh.mjs'

import { recordGshPendingDecrypt } from './buffer.mjs'
import { getCurrentH, getHByGeneration, initGroupH } from './store.mjs'

/** 须加密的 DAG 事件类型 */
export const GSH_ENCRYPT_EVENT_TYPES = new Set(['message', 'message_edit'])

/**
 * @param {unknown} content 事件 content
 * @returns {boolean} 是否为 GSH 密文信封
 */
export function isGshEncryptedContent(content) {
	return content?.gsh?.scheme === 'gsh'
}

/**
 * 联邦入站：消息类事件 content 必须为 GSH 密文（§11，禁明文降级）。
 * @param {string} type 事件类型
 * @param {unknown} content 载荷
 * @returns {void}
 */
export function assertFederatedGshContent(type, content) {
	if (!GSH_ENCRYPT_EVENT_TYPES.has(type)) return
	if (!isGshEncryptedContent(content))
		throw new Error(`federated ${type} requires GSH encrypted content`)
}

/**
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @returns {Promise<{ h: string, generation: number }>} 当前群 H 与代数
 */
async function ensureGroupH(username, groupId) {
	const cur = await getCurrentH(username, groupId)
	if (cur) return cur
	return initGroupH(username, groupId)
}

/**
 * 将明文 content 对象加密为 `{ gsh: { scheme, generation, iv, ciphertext, authTag } }`。
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID（KDF 盐）
 * @param {object} plaintextContent 明文载荷
 * @returns {Promise<object>} 密文 content
 */
export async function encryptEventContent(username, groupId, channelId, plaintextContent) {
	if (!plaintextContent) return plaintextContent
	if (isGshEncryptedContent(plaintextContent)) return plaintextContent
	const { h, generation } = await ensureGroupH(username, groupId)
	const gsh = encryptMessage(JSON.stringify(plaintextContent), h, channelId, generation)
	return { gsh }
}

/**
 * 解密 GSH 信封为明文 content 对象；失败时保留信封并标注 `gshDecryptFailed`。
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {unknown} content 可能为密文或明文
 * @returns {Promise<object>} 明文 content（或带失败标记的对象）
 */
export async function decryptEventContent(username, groupId, channelId, content) {
	if (!content) return {}
	if (!isGshEncryptedContent(content)) return /** @type {object} */ content

	const env = /** @type {{ gsh: { scheme: string, generation?: number } }} */ content
	const gen = env.gsh.generation ?? null
	let H = gen != null ? await getHByGeneration(username, groupId, gen) : null
	if (!H) {
		const cur = await getCurrentH(username, groupId)
		H = cur?.h ?? null
	}
	if (!H) {
		recordGshPendingDecrypt(username, groupId, gen)
		return {
			.../** @type {object} */ content,
			gshDecryptFailed: true,
			gshPendingGeneration: gen,
		}
	}

	const plain = decryptMessage(env.gsh, H, channelId)
	if (plain == null) {
		recordGshPendingDecrypt(username, groupId, gen)
		return {
			.../** @type {object} */ content,
			gshDecryptFailed: true,
			gshPendingGeneration: gen,
		}
	}

	try {
		return JSON.parse(plain)
	}
	catch {
		return plain ? { type: 'text', content: plain } : plain
	}
}

/**
 * 批量解密频道消息 JSONL 行（就地替换 `content`）。
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {object[]} lines 消息行
 * @returns {Promise<object[]>} 解密后的消息行数组
 */
export async function decryptChannelMessageLines(username, groupId, channelId, lines) {
	if (!lines?.length) return lines || []
	return Promise.all(lines.map(async line => {
		if (!line?.content || !isGshEncryptedContent(line.content)) return line
		return { ...line, content: await decryptEventContent(username, groupId, channelId, line.content) }
	}))
}
