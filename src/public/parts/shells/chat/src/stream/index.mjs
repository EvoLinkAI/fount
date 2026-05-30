/**
 * 【文件】src/stream/index.mjs
 * 【职责】后端流式渲染子模块的公共导出入口，供 Char 回复管线与前端 hub 复用 Markdown 与工具块处理工具。
 * 【原理】纯 re-export 桶文件，无运行时逻辑；将 toolBlocks（工具占位/内联执行）与 markdown（围栏代码块、i18n）集中暴露，避免调用方深路径 import。
 * 【数据结构】无本地状态；导出 defineInlineToolUses、defineToolUseBlocks、getChatI18n、renderMarkdown*、inferCodeLanguageFromPath。
 * 【关联】被 chat 生成/预览链路与 public 侧流式 UI import；转发 toolBlocks.mjs、markdown.mjs。
 */
export { defineInlineToolUses, defineToolUseBlocks } from './toolBlocks.mjs'
/**
 *
 */
export {
	getChatI18n,
	inferCodeLanguageFromPath,
	renderMarkdownCodeBlock,
	renderMarkdownInlineCode,
} from './markdown.mjs'
