import { Buffer } from 'node:buffer'

import { info_t } from '../../../../../decl/basedefs.ts'

/** ---- Channels（原 channelAPI.ts）---- */

/**
 *
 */
export type ChannelPermission =
	| 'canPost'
	| 'canEdit'
	| 'canDelete'
	| 'canPin'
	| 'canInvite'
	| 'canRemove'
	| 'canManageRoles'
	| 'canEditChannel'
	| 'canDeleteChannel'
	| 'canViewHistory'

/**
 *
 */
export type ChannelRole = 'owner' | 'admin' | 'moderator' | 'member' | 'subscriber'

/**
 *
 */
/** 运行时 DAG 频道类型（见 `src/group/routes/channels.mjs`）。 */
export type ChannelType = 'text' | 'list' | 'streaming'

/**
 *
 */
export interface ChannelConfig {
	channelId: string
	name: string
	description: string
	avatar?: string
	type: ChannelType
	owner: string
	admins: string[]
	subscribers: string[]
	permissions: {
		canPost: string[]
		canComment: boolean
		isPublic: boolean
	}
	createdAt: number
	updatedAt: number
}

/**
 *
 */
export interface ChannelMessage {
	messageId: string
	channelId: string
	author: string
	content: string
	files?: Array<{
		name: string
		url: string
		type: string
	}>
	isPinned: boolean
	createdAt: number
	updatedAt?: number
}

/**
 *
 */
export interface ChannelMember {
	username: string
	role: ChannelRole
	joinedAt: number
}

/** 频道管理（DAG 事件驱动；见 `groupChannel.mjs` / `channels.mjs`）。 */
export class ChannelAPI_t {
	info: info_t

	Init?: () => Promise<void>
	Load?: () => Promise<void>
	Unload?: (reason: string) => Promise<void>

	interfaces?: {
		createChannel?: (username: string, config: Partial<ChannelConfig>) => Promise<ChannelConfig>
		getChannelList?: (username: string) => Promise<ChannelConfig[]>
		getChannel?: (channelId: string) => Promise<ChannelConfig>
		updateChannel?: (channelId: string, updates: Partial<ChannelConfig>) => Promise<ChannelConfig>
		deleteChannel?: (channelId: string) => Promise<void>
		checkPermission?: (username: string, channelId: string, permission: ChannelPermission) => Promise<boolean>
		getUserRole?: (username: string, channelId: string) => Promise<ChannelRole | null>
	}
}

/** ---- Profile（原 profileAPI.ts）---- */

/**
 *
 */
export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline' | 'away' | 'busy'

/**
 * 资料外链（各 locale 切片内）。
 */
export interface ProfileLink {
	icon?: string
	name?: string
	url: string
}

/**
 * 单 locale 资料切片：与 `single_lang_info_t` 同名字段 + `links`。
 */
export type ProfileLocaleSlice = Partial<import('../../../../../decl/basedefs.ts').single_lang_info_t> & {
	links?: ProfileLink[]
}

/**
 * 实体资料（磁盘与 API 持久化形态）。
 */
export interface UserProfile {
	entityHash: string
	nodeHash: string
	subjectHash: string
	/** 多语言展示字段，键为 locale（如 `zh-CN`） */
	localized: Record<string, ProfileLocaleSlice>
	status: UserStatus
	customStatus?: string
	lastSeenAt?: number
	stats: {
		joinedAt: number
		messageCount: number
		groupCount: number
		channelCount: number
	}
}

/**
 * GET 时在持久化字段之上附加的解析结果（当前查看者 locale）。
 */
export interface UserProfilePresentation extends UserProfile {
	name: string
	avatar: string
	description: string
	description_markdown: string
	version: string
	author: string
	home_page: string
	issue_page: string
	tags: string[]
	links: ProfileLink[]
	effectiveStatus?: UserStatus
	infoDefaults?: ProfileLocaleSlice & { links: ProfileLink[] }
	localeKeys?: string[]
}

/**
 *
 */
export class ProfileAPI_t {
	info: info_t

	Init?: () => Promise<void>
	Load?: () => Promise<void>
	Unload?: (reason: string) => Promise<void>

	interfaces?: {
		getProfile?: (entityHash: string) => Promise<UserProfilePresentation>
		updateProfile?: (entityHash: string, updates: Partial<UserProfile>) => Promise<UserProfilePresentation>
		uploadAvatar?: (entityHash: string, file: Buffer, filename: string) => Promise<string>
		getStats?: (entityHash: string) => Promise<UserProfile['stats']>
		updateStatus?: (entityHash: string, status: UserStatus, customStatus?: string) => Promise<void>
	}
}

/** ---- Stickers（原 stickerAPI.ts）---- */

/**
 *
 */
export interface Sticker {
	id: string
	name: string
	url: string
	tags: string[]
	animated: boolean
}

/**
 *
 */
export interface StickerPack {
	packId: string
	name: string
	author: string
	description: string
	thumbnail?: string
	stickers: Sticker[]
	isPublic: boolean
	createdAt: number
	updatedAt: number
}

/**
 *
 */
export interface UserStickerCollection {
	entityHash: string
	installedPacks: string[]
	favoriteStickers: string[]
	recentStickers: string[]
}

/**
 *
 */
export interface StickerMessage {
	type: 'sticker'
	packId: string
	stickerId: string
	url: string
}

/**
 *
 */
export class StickerAPI_t {
	info: info_t

	Init?: () => Promise<void>
	Load?: () => Promise<void>
	Unload?: (reason: string) => Promise<void>

	interfaces?: {
		getStickerPacks?: (username?: string) => Promise<StickerPack[]>
		createStickerPack?: (username: string, pack: Partial<StickerPack>) => Promise<StickerPack>
		getStickerPack?: (packId: string) => Promise<StickerPack>
		updateStickerPack?: (packId: string, updates: Partial<StickerPack>) => Promise<StickerPack>
		deleteStickerPack?: (packId: string) => Promise<void>
		uploadSticker?: (packId: string, file: Buffer, filename: string, metadata: Partial<Sticker>) => Promise<Sticker>
		deleteSticker?: (packId: string, stickerId: string) => Promise<void>
		installPack?: (username: string, packId: string) => Promise<void>
		uninstallPack?: (username: string, packId: string) => Promise<void>
		getUserCollection?: (username: string) => Promise<UserStickerCollection>
		addToFavorites?: (username: string, stickerId: string) => Promise<void>
		removeFromFavorites?: (username: string, stickerId: string) => Promise<void>
		recordRecentUse?: (username: string, stickerId: string) => Promise<void>
	}
}
