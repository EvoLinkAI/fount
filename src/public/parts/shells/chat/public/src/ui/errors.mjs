/**
 * 【文件】public/src/ui/errors.mjs
 * 【职责】前端用户可见错误统一处理：Sentry 上报 → console → i18n toast。
 * 【原理】handleUIError 捕获 unknown，showToastI18n 展示键名与参数。
 * 【数据结构】error、i18nKey、toastParams。
 * 【关联】@sentry/browser、toast.mjs；groupFileUpload、reactionHandlers。
 */
import * as Sentry from 'https://esm.sh/@sentry/browser'

import { showToastI18n } from '../../../../scripts/toast.mjs'

/**
 * 前端用户可见错误：Sentry → console.log → toast。
 * @param {unknown} error 异常
 * @param {string} i18nKey toast 文案键
 * @param {Record<string, string>} [toastParams] 额外 i18n 插值
 * @returns {void}
 */
export function handleUIError(error, i18nKey, toastParams = {}) {
	Sentry.captureException(error)
	console.log(error)
	showToastI18n('error', i18nKey, { ...toastParams, error: error?.message ?? String(error) })
}
