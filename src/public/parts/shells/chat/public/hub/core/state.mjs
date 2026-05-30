/**
 * 【文件】public/hub/core/state.mjs
 * 【职责】Chat Hub 全局可变 store：群组/频道上下文、消息源、私聊、虚拟列表与搜索等跨模块共享字段（无 DOM 操作）。
 * 【原理】各 hub 子模块读写同一 hubStore 对象；currentGroupId/channelId 由 groupNav/hashNav 在导航时更新；
 *   channelMessagesSource（API 物化行）/channelMessagePipeline 供 messages 渲染；groupEventSyncCursor 供 WS 增量与 DAG 对齐。
 * 【数据结构】hubStore：groups、currentGroupId、currentChannelId、currentState、channelMessages、channelMessagePipeline、
 *   groupEventSyncCursor(Map)、reactionRenderOpts、viewerEntityHash、privateGroup 等。
 * 【关联】被 hub 下几乎所有模块 import；与 urlHash、groupNav、messages、groupStream 协作。
 */
/** Hub 页面共享可变状态（各子模块读写此对象字段）。 */
export const hubStore = {
	groups: [],
	groupFoldersState: { folders: [] },
	groupEventSyncCursor: new Map(),
	dagTips: [],
	fileHandlers: null,
	currentGroupId: null,
	currentChannelId: null,
	currentState: null,
	channelReactionEvents: [],
	channelMessagesSource: [],
	channelMessages: [],
	reactionEventsEtag: '',
	reactionRenderOpts: {
		viewerMemberId: 'local',
		canAddReactions: false,
		canManageMessages: false,
		canPinMessages: false,
	},
	lastMessageId: null,
	/** 顶栏/侧栏展示名（非身份键） */
	viewerDisplayName: null,
	nodeHash: null,
	viewerEntityHash: null,
	collapsedCategories: new Set(),
	currentMode: 'groups',
	channelMessagePipeline: null,
	channelOlderExhausted: { value: false },
	/** 乐观发送中的 `pending:*` eventId；同时最多一条 */
	composerPendingId: null,
	/** 当前文本频道消息搜索关键词（小写）；null 表示未过滤 */
	channelSearchQuery: null,
	/** 好友私聊（角色或用户 DM）；角色时与联邦群 `currentGroupId` 互斥，用户 DM 时复用 `currentGroupId` 拉频道消息。 */
	privateGroup: {
		groupId: null,
		charName: null,
		/** 对端 128 位 entityHash（角色 agent / 用户统一） */
		peerEntityHash: null,
		channelId: 'default',
		refreshStopGenerationButton: null,
		/**
		 *
		 */
		enableComposer: () => { },
		/**
		 *
		 */
		disableComposer: () => { },
		/**
		 *
		 */
		scrollToBottom: () => { },
		/**
		 *
		 */
		applyAvatarsTo: () => { },
		/**
		 *
		 */
		onEnterPrivateGroup: () => { },
	},
}
