/**
 * Mailbox 投递成功后由 Part 消费 envelope（P2P 不解析 DAG）。
 */

/** @typedef {(username: string, records: object[]) => Promise<string[]>} MailboxConsumer */

/**
 * @typedef {{
 *   app: string,
 *   match?: (row: object) => boolean,
 *   handler: MailboxConsumer,
 * }} MailboxConsumerEntry
 */

/** @type {Map<string, MailboxConsumerEntry>} */
const consumers = new Map()

/**
 * @param {string} consumerId 如 chat/dag
 * @param {string | { app: string, match?: (row: object) => boolean }} appOrOpts 应用名或选项
 * @param {MailboxConsumer} [handler] 返回已交付 record id 列表（第二参为 string 时必填）
 * @returns {void}
 */
export function registerMailboxConsumer(consumerId, appOrOpts, handler) {
	if (typeof appOrOpts === 'string') {
		consumers.set(String(consumerId), { app: String(appOrOpts), handler })
		return
	}
	const opts = appOrOpts
	consumers.set(String(consumerId), {
		app: String(opts.app),
		match: typeof opts.match === 'function' ? opts.match : undefined,
		handler,
	})
}

/**
 * @param {string} consumerId 消费者 ID
 * @returns {void}
 */
export function unregisterMailboxConsumer(consumerId) {
	consumers.delete(String(consumerId))
}

/**
 * @param {string} username replica
 * @param {object[]} records mailbox 记录
 * @returns {Promise<string[]>} 所有 consumer 成功交付的 id 并集
 */
export async function dispatchMailboxRecordsToConsumers(username, records) {
	/** @type {Set<string>} */
	const delivered = new Set()
	for (const { app, match, handler } of consumers.values()) {
		const scoped = records.filter(row => {
			if (String(row?.app || '') !== app) return false
			return match ? match(row) : true
		})
		if (!scoped.length) continue
		try {
			const ids = await handler(username, scoped)
			for (const id of ids || []) delivered.add(String(id))
		}
		catch (err) {
			console.error('mailbox: consumer failed', err)
		}
	}
	return [...delivered]
}
