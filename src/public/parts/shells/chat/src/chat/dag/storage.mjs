/**
 * 【文件】`dag/storage.mjs` — DAG 持久化 I/O 原语。
 * 【职责】读写群级 `events.jsonl` 与原子 JSON 快照；提供带 `fsync` 的追加/写入以降低崩溃窗口。
 * 【原理】JSONL 每行一条 DAG 事件，读入时经 `sanitizeFederatedEvent` 净化；`appendJsonlSynced`/`writeJsonAtomicSynced` 在落盘后再 sync，配合 §7 WAL 保证事件先于 checkpoint 落盘。
 * 【数据结构】JSONL 行为事件对象数组；原子 JSON 为完整 checkpoint 或侧车对象。
 * 【关联】`events/wire.mjs`、`materialize.mjs`、`append.mjs`、`remoteIngest.mjs`、`groupLock.mjs`。
 */
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { sanitizeFederatedEvent } from '../events/wire.mjs'

/**
 * 读取 JSONL 文件并解析为对象数组；缺失或读失败时返回空数组。
 * @param {string} filePath 文件系统路径
 * @returns {Promise<object[]>} 各行解析后的对象列表
 */
export async function readJsonl(filePath) {
	try {
		const text = await readFile(filePath, 'utf8')
		return text.split('\n').filter(Boolean).map(line => sanitizeFederatedEvent(JSON.parse(line)))
	}
	catch {
		return []
	}
}

/**
 * 将单个 JSON 对象作为一行追加写入 JSONL（必要时创建父目录）。
 * @param {string} filePath 目标文件路径
 * @param {object} record 要序列化写入的对象
 * @returns {Promise<void>} 写入完成，无业务返回值
 */
export async function appendJsonl(filePath, record) {
	await mkdir(dirname(filePath), { recursive: true })
	await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * 追加一行 JSONL 并 `fsync`，降低崩溃下事件流与快照不一致窗口（先持久化事件再物化快照）。
 * @param {string} filePath 目标路径
 * @param {object} record 记录对象
 * @returns {Promise<void>}
 */
export async function appendJsonlSynced(filePath, record) {
	await mkdir(dirname(filePath), { recursive: true })
	const fh = await open(filePath, 'a')
	try {
		await fh.appendFile(`${JSON.stringify(record)}\n`, 'utf8')
		await fh.sync()
	}
	finally {
		await fh.close()
	}
}

/**
 * 原子写入 JSON 文件（临时文件 + rename）。
 * @param {string} filePath 目标路径
 * @param {object} obj 可 JSON 序列化对象
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(filePath, obj) {
	const dir = dirname(filePath)
	await mkdir(dir, { recursive: true })
	const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
	await writeFile(tmp, JSON.stringify(obj, null, '\t'), 'utf8')
	await rename(tmp, filePath)
}

/**
 * 原子写入 JSON 并对目标文件 `fsync`（快照与 events 尾对齐，§7 WAL）。
 * @param {string} filePath 目标路径
 * @param {object} obj 可序列化对象
 * @returns {Promise<void>}
 */
export async function writeJsonAtomicSynced(filePath, obj) {
	const dir = dirname(filePath)
	await mkdir(dir, { recursive: true })
	const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
	await writeFile(tmp, JSON.stringify(obj, null, '\t'), 'utf8')
	const fh = await open(tmp, 'r+')
	try {
		await fh.sync()
	}
	finally {
		await fh.close()
	}
	await rename(tmp, filePath)
	const outFh = await open(filePath, 'r+')
	try {
		await outFh.sync()
	}
	finally {
		await outFh.close()
	}
}
