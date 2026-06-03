/**
 * 【文件】gsh/content.mjs
 * 【职责】DAG 消息体 GSH 加解密：message/message_edit 密文入联邦线，读盘/频道列表按 generation 解密。
 * 【关联】gsh/store.mjs、buffer.mjs、channel/postMessage、dag 物化、stream/auth。
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
 * 联邦入站：消息类事件 content 必须为 GSH 密文。
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
 * 将明文 content 加密为 GSH 信封。
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID（KDF 盐）
 * @param {object} plaintextContent 明文载荷
 * @returns {Promise<object>} 密文 content
 */
export async function encryptEventContent(username, groupId, channelId, plaintextContent) {
	if (isGshEncryptedContent(plaintextContent) || !plaintextContent) return plaintextContent
	const { h, generation } = await getCurrentH(username, groupId) || initGroupH(username, groupId)
	return { gsh: encryptMessage(JSON.stringify(plaintextContent), h, channelId, generation) }
}

/**
 * 出站联邦前：本地明文 content → GSH wire 形态。
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {object} signPayload 签名事件
 * @returns {Promise<object>} wire 形态事件
 */
export async function encryptSignedEventForWire(username, groupId, signPayload) {
	if (!signPayload || !GSH_ENCRYPT_EVENT_TYPES.has(signPayload.type)) return signPayload
	if (isGshEncryptedContent(signPayload.content)) return signPayload
	const channelId = signPayload.channelId || 'default'
	const content = await encryptEventContent(username, groupId, channelId, signPayload.content)
	return { ...signPayload, content }
}

/**
 * 补拉响应：频道消息行 content 转为 GSH wire 形态。
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {object} line 消息行
 * @returns {Promise<object>} wire 形态行
 */
export async function encryptMessageLineForWire(username, groupId, channelId, line) {
	if (!line?.content || isGshEncryptedContent(line.content)) return line
	const content = await encryptEventContent(username, groupId, channelId, line.content)
	return { ...line, content }
}

/**
 * 解密 GSH 信封为明文 content；失败时保留信封并标注 `gshDecryptFailed`。
 * @param {string} username 本地用户
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @param {unknown} content 可能为密文或明文
 * @returns {Promise<object>} 明文 content（或带失败标记的对象）
 */
export async function decryptEventContent(username, groupId, channelId, content) {
	if (!isGshEncryptedContent(content)) return content

	const keyGeneration = content.gsh.generation ?? null
	let groupKey = keyGeneration != null ? await getHByGeneration(username, groupId, keyGeneration) : null
	groupKey ??= (await getCurrentH(username, groupId))?.h ?? null

	if (!groupKey) {
		recordGshPendingDecrypt(username, groupId, keyGeneration)
		return { ...content, gshDecryptFailed: true, gshPendingGeneration: keyGeneration }
	}

	const decryptedText = decryptMessage(content.gsh, groupKey, channelId)
	if (decryptedText == null) {
		recordGshPendingDecrypt(username, groupId, keyGeneration)
		return { ...content, gshDecryptFailed: true, gshPendingGeneration: keyGeneration }
	}

	try {
		return JSON.parse(decryptedText)
	}
	catch {
		return decryptedText ? { type: 'text', content: decryptedText } : decryptedText
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
