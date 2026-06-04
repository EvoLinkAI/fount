import { Buffer } from 'node:buffer'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * 读取 JSONL 文件并解析为对象数组；缺失或读失败时返回空数组。
 * @param {string} filePath 文件系统路径
 * @param {{ sanitize?: (row: object) => object }} [options] 可选净化函数
 * @returns {Promise<object[]>} 各行解析后的对象列表
 */
export async function readJsonl(filePath, options = {}) {
	try {
		const text = await readFile(filePath, 'utf8')
		const sanitize = typeof options.sanitize === 'function' ? options.sanitize : row => row
		return text.split('\n').filter(Boolean).map(line => sanitize(JSON.parse(line)))
	}
	catch {
		return []
	}
}

/**
 * 流式读取 JSONL（避免整文件读入内存）。
 * @param {string} filePath 文件路径
 * @param {{ sanitize?: (row: object) => object }} [options] 行净化
 * @returns {AsyncGenerator<object>} 逐行事件
 */
export async function* readJsonlStream(filePath, options = {}) {
	const sanitize = typeof options.sanitize === 'function' ? options.sanitize : row => row
	let input
	try {
		input = createReadStream(filePath, { encoding: 'utf8' })
	}
	catch {
		return
	}
	const lines = createInterface({ input, crlfDelay: Infinity })
	for await (const line of lines) {
		const trimmed = String(line).trim()
		if (!trimmed) continue
		try {
			yield sanitize(JSON.parse(trimmed))
		}
		catch { /* skip bad line */ }
	}
}

/**
 * 流式过滤重写 JSONL：保留 `keep(row)===true` 的行。
 * @param {string} filePath 目标路径
 * @param {(row: object) => boolean} keep 保留谓词
 * @param {{ sanitize?: (row: object) => object }} [options] 读行净化
 * @returns {Promise<{ kept: number, dropped: number }>} 统计
 */
export async function rewriteJsonlKeeping(filePath, keep, options = {}) {
	const dir = dirname(filePath)
	await mkdir(dir, { recursive: true })
	const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
	/** @type {object[]} */
	const buffer = []
	let kept = 0
	let dropped = 0
	/**
	 *
	 */
	const flush = async () => {
		if (!buffer.length) return
		const block = buffer.map(row => `${JSON.stringify(row)}\n`).join('')
		await appendFile(tmp, block, 'utf8')
		buffer.length = 0
	}
	try {
		for await (const row of readJsonlStream(filePath, options))
			if (keep(row)) {
				buffer.push(row)
				kept++
				if (buffer.length >= WRITE_JSONL_CHUNK_LINES)
					await flush()
			}
			else dropped++
		await flush()
	}
	catch { /* source missing */ }
	if (kept > 0 || dropped > 0) await rename(tmp, filePath)
	else 
		try { await writeFile(filePath, '', 'utf8') }
		catch { /* ok */ }
	
	return { kept, dropped }
}

/**
 * 读取 JSONL 末行事件的 `id`（DAG tip）；空文件为 null。
 * @param {string} filePath 文件路径
 * @returns {Promise<string | null>} tip event id
 */
export async function readJsonlTipId(filePath) {
	try {
		const fh = await open(filePath, 'r')
		try {
			const { size } = await fh.stat()
			if (!size) return null
			const chunk = Math.min(size, 65_536)
			const buf = Buffer.alloc(chunk)
			await fh.read(buf, 0, chunk, size - chunk)
			const lines = buf.toString('utf8').split('\n').filter(Boolean)
			const last = lines[lines.length - 1]
			if (!last) return null
			const row = JSON.parse(last)
			return row?.id != null ? String(row.id) : null
		}
		finally {
			await fh.close()
		}
	}
	catch {
		return null
	}
}

/**
 * 将单个 JSON 对象作为一行追加写入 JSONL（必要时创建父目录）。
 * @param {string} filePath 目标文件路径
 * @param {object} record 要序列化写入的对象
 * @returns {Promise<void>}
 */
export async function appendJsonl(filePath, record) {
	await mkdir(dirname(filePath), { recursive: true })
	await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * 追加一行 JSONL 并 `fsync`。
 * @param {string} filePath 目标路径
 * @param {object} record 记录对象
 * @returns {Promise<void>}
 */
/** 流式重写 JSONL 时分块写入的行数上限 */
const WRITE_JSONL_CHUNK_LINES = 1000

/**
 * 流式重写 JSONL（临时文件 + rename），避免大数组 join 的内存峰值。
 * @param {string} filePath 目标路径
 * @param {object[]} records 行对象列表
 * @returns {Promise<void>}
 */
export async function writeJsonl(filePath, records) {
	const dir = dirname(filePath)
	await mkdir(dir, { recursive: true })
	const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
	const stream = createWriteStream(tmp, { encoding: 'utf8' })
	try {
		for (let i = 0; i < records.length; i += WRITE_JSONL_CHUNK_LINES) {
			const chunk = records.slice(i, i + WRITE_JSONL_CHUNK_LINES)
				.map(record => `${JSON.stringify(record)}\n`)
				.join('')
			if (!stream.write(chunk))
				await new Promise(resolve => stream.once('drain', resolve))
		}
		await new Promise((resolve, reject) => {
			stream.on('finish', resolve)
			stream.on('error', reject)
			stream.end()
		})
	}
	catch (err) {
		stream.destroy()
		throw err
	}
	await rename(tmp, filePath)
}

/**
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
 * 原子写入 JSON 并对目标文件 `fsync`。
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
