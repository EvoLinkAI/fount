/**
 * 群设置中的帖子归档/热区参数解析。
 */

/**
 * @param {object} [groupSettings] 物化群设置
 * @returns {{
 *   hotEarliest: number,
 *   pinContext: number,
 *   dagFoldAfterArchive: boolean,
 *   autoPruneMessagesJsonl: boolean,
 *   autoPruneDagMessages: boolean,
 * }} 归档相关群设置
 */
export function archiveSettingsFromGroup(groupSettings = {}) {
	return {
		hotEarliest: Math.max(0, Number(groupSettings.hotEarliestMessageCount) || 50),
		pinContext: Math.max(0, Number(groupSettings.pinContextMessageCount) || 30),
		dagFoldAfterArchive: groupSettings.dagFoldAfterArchive !== false,
		autoPruneMessagesJsonl: groupSettings.autoPruneMessagesJsonl === true,
		autoPruneDagMessages: groupSettings.autoPruneDagMessages === true,
	}
}

/**
 * 归档分桶：仅 UTC 自然月 `YYYY-MM`（与节点本地时区无关）。
 * @param {number} wallMs HLC wall 毫秒（UTC 语义）
 * @returns {string} `YYYY-MM`
 */
export function archiveMonthKey(wallMs) {
	const d = new Date(Number(wallMs) || Date.now())
	const y = d.getUTCFullYear()
	const m = String(d.getUTCMonth() + 1).padStart(2, '0')
	return `${y}-${m}`
}
