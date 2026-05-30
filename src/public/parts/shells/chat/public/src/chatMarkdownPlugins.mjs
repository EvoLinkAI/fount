/**
 * 【文件】public/src/chatMarkdownPlugins.mjs
 * 【职责】remark/rehype 插件：展开 #[group/channel] 链接；剥离不可信作者的危险标签。
 * 【原理】visit 文本节点替换 channel 链接；rehype 删除 script/iframe 等 BLOCKED_TAG_NAMES。
 * 【数据结构】unist 树；BLOCKED_TAG_NAMES Set。
 * 【关联】chatMarkdownConvertor.mjs、expandChannelLinks.mjs。
 */
import { visit } from 'https://esm.sh/unist-util-visit'

import { expandChannelLinksInText } from './lib/expandChannelLinks.mjs'

const BLOCKED_TAG_NAMES = new Set([
	'script',
	'style',
	'iframe',
	'object',
	'embed',
	'link',
	'meta',
	'base',
	'form',
])

const SAFE_URL_SCHEMES = /^(https?:|mailto:|tel:|#|\/|about:blank#)/i

/**
 * 将聊天方言 `#[group/channel]`、`#[group]` 展开为 Markdown 链接（remark 阶段）。
 * @returns {(tree: import('npm:@types/mdast').Root) => void} remark 插件
 */
export function remarkExpandChannelLinks() {
	return tree => {
		visit(tree, 'text', node => {
			if (typeof node.value === 'string' && node.value.includes('#['))
				node.value = expandChannelLinksInText(node.value)
		})
	}
}

/**
 * 不可信内容 rehype 净化：移除危险标签、事件属性与非安全 URL。
 * @returns {(tree: import('npm:@types/hast').Root) => void} rehype 插件
 */
export function rehypeSanitizeUntrustedContent() {
	return () => tree => {
		visit(tree, 'element', (node, index, parent) => {
			if (!parent || index == null) return
			const tagName = String(node.tagName || '').toLowerCase()
			if (BLOCKED_TAG_NAMES.has(tagName)) {
				parent.children.splice(index, 1)
				return index
			}
			const properties = node.properties || {}
			for (const propertyName of Object.keys(properties)) {
				const lowerName = propertyName.toLowerCase()
				if (lowerName.startsWith('on')) {
					delete properties[propertyName]
					continue
				}
				if (lowerName === 'src' || lowerName === 'href' || lowerName === 'xlink:href') {
					const url = String(properties[propertyName] || '')
					if (url && !SAFE_URL_SCHEMES.test(url.trim()))
						delete properties[propertyName]
				}
			}
		})
	}
}
