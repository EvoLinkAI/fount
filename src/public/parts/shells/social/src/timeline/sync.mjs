import { computeEventId, eventBodyForSign } from '../../../../../../scripts/p2p/dag/index.mjs'
import { appendJsonlSynced, readJsonl } from '../../../../../../scripts/p2p/dag/storage.mjs'
import { tryImportFollowApproveVault } from '../gsh/followApproveImport.mjs'
import { timelineEventsPath } from '../paths.mjs'


import { canonicalizeSignedTimelineEvent } from './canonicalizeEvent.mjs'

/**
 * 导入远程时间线事件（联邦 social_timeline_put / mailbox）。
 * @param {string} username 本地用户
 * @param {string} entityHash 时间线 owner
 * @param {object} event 签名事件
 * @returns {Promise<boolean>} 是否新写入
 */
export async function ingestRemoteTimelineEvent(username, entityHash, event) {
	if (!event?.id || !event?.signature) return false
	const body = eventBodyForSign(event)
	if (computeEventId(body) !== event.id) return false
	const existing = await readJsonl(timelineEventsPath(username, entityHash))
	if (existing.some(row => row.id === event.id)) return false
	const row = canonicalizeSignedTimelineEvent(event)
	await appendJsonlSynced(timelineEventsPath(username, entityHash), row)
	await tryImportFollowApproveVault(username, entityHash, event)
	return true
}

/**
 * 扫描本地 mailbox 中属于该 entity 的时间线事件。
 * @param {string} username 用户
 * @param {string} entityHash 目标时间线
 * @returns {Promise<number>} 导入条数
 */
export async function syncTimelineFromMailbox(username, entityHash) {
	const { readFile } = await import('node:fs/promises')
	const { mailboxStorePath } = await import('../../chat/src/chat/lib/paths.mjs')
	const { isEnoent } = await import('../../chat/src/chat/lib/utils.mjs')
	let text
	try {
		text = await readFile(mailboxStorePath(username), 'utf8')
	}
	catch (error) {
		if (isEnoent(error)) return 0
		throw error
	}
	let imported = 0
	for (const line of text.split('\n').filter(Boolean)) {
		const row = JSON.parse(line)
		const { envelope } = row
		if (!envelope || envelope.timelineEntityHash !== entityHash) continue
		if (await ingestRemoteTimelineEvent(username, entityHash, envelope.event))
			imported++
	}
	return imported
}
