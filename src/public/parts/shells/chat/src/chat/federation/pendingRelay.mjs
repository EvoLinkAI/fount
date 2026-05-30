/**
 * 【文件】federation/pendingRelay.mjs
 * 【职责】物化 ACL 未就绪时暂缓联邦中继的事件持久队列（§2.1），checkpoint/成员快照就绪后批量刷出。
 * 【原理】enqueuePendingRelay 追加 sanitize 后事件到 pending_relay.jsonl；flushPendingRelay 逐条调用 publish 闭包，失败行写回文件。与 acl.shouldDeferFederatedRelay 配对使用，本地落盘仍可进行。
 * 【数据结构】pending_relay.jsonl 行与 events.jsonl 同形的签名事件；刷出返回成功条数。
 * 【关联】acl.mjs、index.mjs publishSignedEventToFederation、lib/paths.mjs pendingRelayPath、dag/storage readJsonl。
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { readJsonl, appendJsonlSynced } from '../dag/storage.mjs'
import { sanitizeFederatedEvent } from '../events/wire.mjs'
import { pendingRelayPath } from '../lib/paths.mjs'

/**
 * 无物化 ACL 时暂缓中继的事件队列（§2.1）；checkpoint 就绪后刷出。
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {object} signPayload 签名事件
 * @returns {Promise<void>}
 */
export async function enqueuePendingRelay(username, groupId, signPayload) {
	if (!signPayload?.id) return
	const p = pendingRelayPath(username, groupId)
	await mkdir(dirname(p), { recursive: true })
	await appendJsonlSynced(p, sanitizeFederatedEvent(signPayload))
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {(ev: object) => Promise<void>} publish 单条中继闭包
 * @returns {Promise<number>} 成功刷出条数
 */
export async function flushPendingRelay(username, groupId, publish) {
	const p = pendingRelayPath(username, groupId)
	const rows = await readJsonl(p)
	if (!rows.length) return 0
	const { writeFile, unlink } = await import('node:fs/promises')
	await writeFile(p, '', 'utf8')
	let n = 0
	for (const ev of rows)
		try {
			await publish(ev)
			n++
		}
		catch (e) {
			console.error('federation: pending relay flush failed', e)
			await appendJsonlSynced(p, ev)
		}

	try {
		const left = await readJsonl(p)
		if (!left.length) await unlink(p).catch(() => { })
	}
	catch { /* ignore */ }
	return n
}
