/**
 * Mailbox 投递成功后由 Part 消费 envelope（P2P 不解析 DAG）。
 */

/** @typedef {(username: string, records: object[]) => Promise<string[]>} MailboxConsumer */

/** @type {Map<string, MailboxConsumer>} */
const consumers = new Map()

/**
 * @param {string} consumerId 如 chat/dag
 * @param {MailboxConsumer} handler 返回已交付 record id 列表
 * @returns {void}
 */
export function registerMailboxConsumer(consumerId, handler) {
	consumers.set(String(consumerId), handler)
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
	for (const handler of consumers.values()) 
		try {
			const ids = await handler(username, records)
			for (const id of ids || []) delivered.add(String(id))
		}
		catch (err) {
			console.error('mailbox: consumer failed', err)
		}
	
	return [...delivered]
}
