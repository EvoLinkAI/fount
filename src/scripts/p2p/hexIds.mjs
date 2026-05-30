/** 64 位小写十六进制（DAG 事件 id、公钥哈希等）。 */
export const HEX_ID_64 = /^[\da-f]{64}$/u

/** 签名 hex（128 字符）。 */
export const SIGNATURE_HEX_128 = /^[\da-f]{128}$/u

/** `blob:<64hex>` 存储定位符。 */
export const BLOB_STORAGE_LOCATOR_RE = /^blob:([\da-f]{64})$/u

/** `local:…/chunks/<64hex>.bin` 群分块路径。 */
export const LOCAL_CHUNK_FILE_RE = /^local:[^/]+\/chunks\/([\da-f]{64})\.bin$/u

/**
 * @param {unknown} value 原始字符串
 * @returns {string} trim + 去 0x + 小写
 */
export function normalizeHex64(value) {
	return String(value ?? '').trim().toLowerCase().replace(/^0x/iu, '')
}

/**
 * @param {unknown} value 待校验值
 * @returns {boolean} 是否为 64 位 hex
 */
export function isHex64(value) {
	return HEX_ID_64.test(normalizeHex64(value))
}

/**
 * @param {unknown} value 待校验值
 * @returns {boolean} 是否为 128 位签名 hex
 */
export function isSignatureHex128(value) {
	return SIGNATURE_HEX_128.test(String(value ?? '').trim())
}
