/**
 * 【文件】src/upload/fromRequest.mjs
 * 【职责】从 Express 全局 fileupload 中间件解析后的 req.files 中取出单字段上传，并校验图片 MIME/扩展名。
 * 【原理】fount 已在 HTTP 层统一 multipart 解析，路由只需 pickUploadedFile(req, field) 得到 buffer 三元组；
 *   isAllowedImageUpload 要求 extname 与 mimetype 同时匹配 jpeg|jpg|png|gif|webp，防止仅改扩展名的伪装。
 * 【数据结构】返回 { buffer, originalname, mimetype } | null；无文件或缺 data 时 null。
 * 【关联】群表情、附件上传等路由使用；不自行解析 multipart。
 */
import { Buffer } from 'node:buffer'
import path from 'node:path'

/**
 * 从 express-fileupload 填充的 `req.files` 取单字段文件（fount 全局中间件已解析 multipart）。
 * @param {import('npm:express').Request} req HTTP 请求
 * @param {string} field 表单字段名
 * @returns {{ buffer: Buffer, originalname: string, mimetype: string } | null} 文件或 null
 */
export function pickUploadedFile(req, field) {
	const raw = req.files?.[field]
	if (!raw) return null
	const file = Array.isArray(raw) ? raw[0] : raw
	if (!file?.data) return null
	return {
		buffer: Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data),
		originalname: file.name || 'upload',
		mimetype: file.mimetype || 'application/octet-stream',
	}
}

/**
 * @param {{ originalname: string, mimetype: string }} file 上传文件元数据
 * @returns {boolean} 是否为允许的图片类型
 */
export function isAllowedImageUpload(file) {
	const allowedTypes = /jpeg|jpg|png|gif|webp/
	const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase())
	const mimetype = allowedTypes.test(file.mimetype)
	return mimetype && extname
}
