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
 * @param {number} wallMs 毫秒时间戳
 * @returns {string} `YYYY-MM`
 */
export function archiveMonthKey(wallMs) {
	const d = new Date(Number(wallMs) || Date.now())
	const y = d.getUTCFullYear()
	const m = String(d.getUTCMonth() + 1).padStart(2, '0')
	return `${y}-${m}`
}
