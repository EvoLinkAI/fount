/**
 * 【文件】profile/actions.mjs
 * 【职责】CLI/IPC 可调用的个人资料命令表，无 HTTP 时更新显示名与状态。
 * 【原理】各 action 取 operator entityHash 后委托 getProfile/updateProfile/updateStatus；localized 写入指定 locale 切片 name。
 * 【数据结构】actions 对象键（get/updateDisplayName/updateStatus 等）、entityHash、locale 字符串。
 * 【关联】被 chat shell handleAction 动态引用；依赖 profile.mjs、localized.mjs、replica.mjs。
 */
import { getOperatorEntityHash } from '../chat/lib/replica.mjs'

import { normalizeLocalizedMap } from './localized.mjs'
import {
	getProfile,
	updateProfile,
	updateStatus as setEntityStatus,
} from './profile.mjs'

/**
 * 个人资料操作（IPC；身份为 entityHash）
 */
export const actions = {
	/**
	 * 获取用户资料
	 * @param {object} params 参数
	 * @param {string} params.user replica 登录名
	 * @returns {Promise<string>} JSON 文本
	 */
	async get({ user }) {
		const entityHash = getOperatorEntityHash(user)
		const profile = await getProfile(entityHash, user)
		return JSON.stringify(profile, null, 2)
	},

	/**
	 * 更新显示名称（写入主 locale 切片 `name`）
	 * @param {object} params 参数
	 * @param {string} params.user replica 登录名
	 * @param {string} params.name 显示名称
	 * @param {string} [params.locale] locale 键，默认 `zh-CN`
	 * @returns {Promise<string>} 结果消息
	 */
	async updateDisplayName({ user, name, locale = 'zh-CN' }) {
		const entityHash = getOperatorEntityHash(user)
		const profile = await getProfile(entityHash, user, { skipPresentation: true })
		const localized = normalizeLocalizedMap(profile.localized)
		localized[locale] = { ...localized[locale], name: String(name || '').trim() }
		await updateProfile(user, entityHash, { localized })
		return `Display name updated to: ${name}`
	},

	/**
	 * 更新个人简介（写入 `description`）
	 * @param {object} params 参数
	 * @param {string} params.user replica 登录名
	 * @param {string} params.description 个人简介
	 * @param {string} [params.locale] locale 键
	 * @returns {Promise<string>} 结果消息
	 */
	async updateBio({ user, description, locale = 'zh-CN' }) {
		const entityHash = getOperatorEntityHash(user)
		const profile = await getProfile(entityHash, user, { skipPresentation: true })
		const localized = normalizeLocalizedMap(profile.localized)
		localized[locale] = { ...localized[locale], description: String(description || '') }
		await updateProfile(user, entityHash, { localized })
		return 'Description updated'
	},

	/**
	 * 更新状态
	 * @param {object} params 参数
	 * @param {string} params.user replica 登录名
	 * @param {string} params.status 状态
	 * @param {string} [params.customStatus] 自定义状态
	 * @returns {Promise<string>} 结果消息
	 */
	async updateStatus({ user, status, customStatus = '' }) {
		const entityHash = getOperatorEntityHash(user)
		await setEntityStatus(user, entityHash, status, customStatus)
		return `Status updated to: ${status}`
	},
}
