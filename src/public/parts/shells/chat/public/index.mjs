/**
 * 【文件】public/index.mjs
 * 【职责】chat shell 根 URL 入口：应用主题与 i18n 后，将带 hash 的旧链接重定向到 Hub。
 * 【原理】读取 location.hash（如 #group:…），replace 到 /parts/shells:chat/hub/{hash}；经典单页 UI 已废弃。
 * 【数据结构】无模块状态；仅依赖 window.location。
 * 【关联】Hub index；@pages/scripts/theme.mjs、i18n.mjs。
 */
import { initTranslations } from '../../scripts/i18n.mjs'
import { applyTheme } from '../../scripts/theme.mjs'

/**
 *
 */
async function init() {
	applyTheme()
	await initTranslations('chat')
	const h = window.location.hash
	window.location.replace(`/parts/shells:chat/hub/${h}`)
}

void init()
