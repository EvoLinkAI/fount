/**
 * 【文件】public/src/api/groupApi.mjs
 * 【职责】群/DM 前端 API 统一导出入口（barrel）：Hub、设置、深链等只需 import 本文件。
 * 【原理】按域拆分到 groupClient/Core/Channel/Dm/Bookmarks/Ban/Governance/Federation/federationSettings，此处仅 re-export，无运行时逻辑。
 * 【数据结构】导出 groupFetch/groupPath/groupRequest 与各域 async 函数集合。
 * 【关联】Hub、groupSettings、deepLinkConsume、dmLink 等；实现分散在 api/*.mjs。
 */
export { groupFetch, groupPath, groupRequest } from './groupClient.mjs'

/**
 *
 */
export {
	createGroup,
	fetchGroupAuditLog,
	getGroupChatConfig,
	getMembersPage,
	getGroupList,
	getGroupState,
	getStreamingChannelAuth,
	joinGroup,
	leaveGroup,
	createGroupInvite,
	deleteGroupFile,
	updateFileSystemFolder,
} from './groupCore.mjs'

/**
 *
 */
export {
	castChannelVote,
	createChannel,
	createChannelThread,
	createChannelVote,
	deleteChannelMessage,
	editChannelMessage,
	getChannelMessages,
	getStreamBufferChunks,
	getChatTimeline,
	modifyChannelTimeline,
	pinMessage,
	unpinMessage,
	requestChannelHistoryFromPeers,
	sendGroupMessage,
	setChannelMessageFeedback,
	triggerChannelReply,
	updateChannel,
	deleteChannel,
	setDefaultChannel,
	updateChannelListItems,
} from './groupChannel.mjs'

/**
 *
 */
export { createDirectMessageByPubKeys } from './groupDm.mjs'

/**
 *
 */
export {
	addChatBookmark,
	getChatBookmarks,
	saveChatBookmarks,
} from './groupBookmarks.mjs'

/**
 *
 */
export { banMemberWithScope } from './groupBan.mjs'

/**
 *
 */
export {
	blockUser,
	blockOpposingForkBranch,
	forkGroupAsNew,
	mergeDagTips,
	postReputationSlash,
	rotateGroupKey,
	setGovernanceBranch,
	submitOwnerSuccession,
	unbanMember,
} from './groupGovernance.mjs'

/**
 *
 */
export {
	federationCatchUp,
	postFederationTuning,
	pullGroupEvents,
	rebindFederationRoom,
} from './groupFederation.mjs'

/**
 *
 */
export {
	getFederationSettings,
	putFederationSettings,
} from './federationSettings.mjs'
