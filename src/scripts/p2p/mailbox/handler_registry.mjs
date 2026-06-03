/**
 * @typedef {{
 *   ingestPut: (username: string, put: object) => Promise<void>
 *   respondWant: (username: string, want: object, sendGive: (wire: object, peerId: string) => void, peerId: string) => Promise<void>
 *   ingestGive: (username: string, groupId: string, give: object) => Promise<number>
 * }} MailboxHandlers
 */

/** @type {MailboxHandlers | null} */
let handlers = null

/**
 * @param {MailboxHandlers} next Chat shell 在 Load 时注册
 * @returns {void}
 */
export function registerMailboxHandlers(next) {
	handlers = next
}

/** @returns {void} */
export function unregisterMailboxHandlers() {
	handlers = null
}

/**
 * @returns {MailboxHandlers | null} 已注册处理器
 */
export function getMailboxHandlers() {
	return handlers
}
