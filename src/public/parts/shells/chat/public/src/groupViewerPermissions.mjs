/**
 * 【文件】public/src/groupViewerPermissions.mjs
 * 【职责】从 state JSON 解析当前观众在频道上的权限位（发消息、反应、管理等）。
 * 【原理】fetchViewerChannelPermissions 读 viewerMemberPubKeyHash 与 channel 权限表；导出 viewerCan* 便捷判断。
 * 【数据结构】Record<string, boolean> 权限表；stateJson.viewerMemberPubKeyHash。
 * 【关联】Hub composer、reactionHandlers；后端 groups/:id/state。
 */
/**
 * @param {object} stateJson `/groups/:id/state` 的 JSON
 * @param {string} groupId 群 ID
 * @param {string} channelId 频道 ID
 * @returns {Promise<Record<string, boolean>>} 权限表
 */
export async function fetchViewerChannelPermissions(stateJson, groupId, channelId) {
	const pubKeyHash = stateJson?.viewerMemberPubKeyHash
	if (!pubKeyHash) return {}
	const response = await fetch(
		`/api/parts/shells:chat/groups/${encodeURIComponent(groupId)}/permissions?pubKeyHash=${encodeURIComponent(pubKeyHash)}&channelId=${encodeURIComponent(channelId)}`,
		{ credentials: 'include' },
	)
	if (!response.ok) return {}
	return response.json()
}

/**
 * @param {object} stateJson state
 * @param {string} groupId 群
 * @param {string} channelId 频道
 * @returns {Promise<boolean>} 是否可添加/撤销自己的 reaction
 */
export async function viewerCanAddReactions(stateJson, groupId, channelId) {
	const permissions = await fetchViewerChannelPermissions(stateJson, groupId, channelId)
	return permissions.ADD_REACTIONS === true
}

/**
 * @param {object} stateJson state
 * @param {string} groupId 群
 * @param {string} channelId 频道
 * @returns {Promise<boolean>} 是否可代删他人 reaction
 */
export async function viewerCanManageMessages(stateJson, groupId, channelId) {
	const permissions = await fetchViewerChannelPermissions(stateJson, groupId, channelId)
	return permissions.MANAGE_MESSAGES === true
}

/**
 * @param {object} stateJson state
 * @param {string} groupId 群
 * @param {string} channelId 频道
 * @returns {Promise<boolean>} 是否可置顶消息
 */
export async function viewerCanPinMessages(stateJson, groupId, channelId) {
	const permissions = await fetchViewerChannelPermissions(stateJson, groupId, channelId)
	return permissions.PIN_MESSAGES === true
}

/**
 * @param {object} stateJson state
 * @param {string} groupId 群
 * @returns {Promise<boolean>} 当前查看者是否具备发起继任投票（管理员）资格
 */
export async function viewerCanOwnerSuccession(stateJson, groupId) {
	if (!stateJson?.viewerMemberPubKeyHash) return false
	const channelId = stateJson.groupSettings?.defaultChannelId
		|| Object.keys(stateJson.channels || {})[0]
		|| 'default'
	const response = await fetch(
		`/api/parts/shells:chat/groups/${encodeURIComponent(groupId)}/permissions?pubKeyHash=${encodeURIComponent(stateJson.viewerMemberPubKeyHash)}&channelId=${encodeURIComponent(channelId)}`,
	)
	if (!response.ok) return false
	const permissions = await response.json()
	return permissions.ADMIN === true
}
