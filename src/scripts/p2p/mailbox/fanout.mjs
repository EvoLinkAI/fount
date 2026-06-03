import { getNodeHash } from '../node_context.mjs'

/**
 * @param {string} username replica 登录名
 * @param {string} actionName mailbox_put | mailbox_want
 * @param {object} wire 线载荷
 * @param {number} limit fanout 上限
 * @returns {Promise<number>} 发送次数
 */
async function fanoutMailboxAction(username, actionName, wire, limit) {
	const { fanoutToTopNodes } = await import('../trust_graph.mjs')
	const payload = { ...wire, nodeHash: wire.nodeHash || getNodeHash(username) }
	return fanoutToTopNodes(username, actionName, payload, limit)
}

/**
 * @param {string} username replica 登录名
 * @param {object} wire mailbox_put 载荷
 * @param {number} [limit=8] fanout 上限
 * @returns {Promise<number>} 发送次数
 */
export function fanoutMailboxPut(username, wire, limit = 8) {
	return fanoutMailboxAction(username, 'mailbox_put', wire, limit)
}

/**
 * @param {string} username replica 登录名
 * @param {object} wire mailbox_want 载荷
 * @param {number} [limit=6] fanout 上限
 * @returns {Promise<number>} 发送次数
 */
export function fanoutMailboxWant(username, wire, limit = 6) {
	return fanoutMailboxAction(username, 'mailbox_want', wire, limit)
}
