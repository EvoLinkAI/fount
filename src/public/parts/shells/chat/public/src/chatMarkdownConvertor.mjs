/**
 * 【文件】public/src/chatMarkdownConvertor.mjs
 * 【职责】按作者信任级别提供 unified Markdown 处理器（可信/不可信两套 pipeline）。
 * 【原理】GetMarkdownConvertor 加 remarkExpandChannelLinks 与 rehypeSanitizeUntrustedContent；懒加载单例 processor。
 * 【数据结构】markdownConvertorForTrustedContent / ForUntrustedContent Processor。
 * 【关联】chatMarkdownPlugins.mjs、groupMode 离屏守卫；Hub 消息气泡渲染。
 */
import { GetMarkdownConvertor } from '../../../scripts/markdownConvertor.mjs'

import { remarkExpandChannelLinks, rehypeSanitizeUntrustedContent } from './chatMarkdownPlugins.mjs'

/** @type {import('npm:unified').Processor | undefined} */
let markdownConvertorForTrustedContent
/** @type {import('npm:unified').Processor | undefined} */
let markdownConvertorForUntrustedContent

/**
 * 获取聊天消息 Markdown 转换器（可信 / 不可信各缓存一份）。
 * @param {boolean} isTrustedAuthorContent 是否来自已信任作者
 * @returns {Promise<import('npm:unified').Processor>} 缓存的 unified 处理器
 */
export async function getChatMarkdownConvertor(isTrustedAuthorContent) {
	if (isTrustedAuthorContent) {
		markdownConvertorForTrustedContent ??= await GetMarkdownConvertor({
			extraRemarkPlugins: [remarkExpandChannelLinks],
		})
		return markdownConvertorForTrustedContent
	}
	markdownConvertorForUntrustedContent ??= await GetMarkdownConvertor({
		extraRemarkPlugins: [remarkExpandChannelLinks],
		extraRehypePlugins: [rehypeSanitizeUntrustedContent],
	})
	return markdownConvertorForUntrustedContent
}
