import { getMailboxHandlers } from './handler_registry.mjs'
import { parseMailboxGive, parseMailboxPut, parseMailboxWant } from './parse.mjs'

/**
 * 用户级联邦房间挂载 mailbox_put / want / give（不经 part_invoke 自环 Chat）。
 * @param {string} username replica 登录名
 * @param {{ on: (name: string, handler: (payload: unknown, peerId: string) => void) => void, send: (name: string, payload: unknown, peerId: string | null) => void }} wire Trystero actions
 * @returns {void}
 */
export function attachMailboxWire(username, wire) {
	wire.on('mailbox_put', (payload, peerId) => {
		void peerId
		const put = parseMailboxPut(payload)
		const h = getMailboxHandlers()
		if (!put || !h) return
		void h.ingestPut(username, put).catch(err => console.error('mailbox: put ingest failed', err))
	})

	wire.on('mailbox_want', (payload, peerId) => {
		const want = parseMailboxWant(payload)
		const h = getMailboxHandlers()
		if (!want || !h) return
		void h.respondWant(username, want, (giveWire, targetPeerId) => {
			try {
				wire.send('mailbox_give', giveWire, targetPeerId)
			}
			catch { /* disconnected */ }
		}, peerId).catch(err => console.error('mailbox: want failed', err))
	})

	wire.on('mailbox_give', (payload, peerId) => {
		void peerId
		const give = parseMailboxGive(payload)
		const h = getMailboxHandlers()
		if (!give || !h) return
		void h.ingestGive(username, '', give).catch(err => console.error('mailbox: give ingest failed', err))
	})
}
