/**
 * Feed 条目按 HLC 降序比较（与 buildHomeFeed 历史排序一致）。
 * @param {object} left 左侧 feed 条目
 * @param {object} right 右侧 feed 条目
 * @returns {number} 正数表示 left 更新
 */
export function compareFeedItems(left, right) {
	const lw = Number(left.hlc?.wall) || 0
	const rw = Number(right.hlc?.wall) || 0
	if (lw !== rw) return lw - rw
	return String(left.postId).localeCompare(String(right.postId))
}

/**
 * 多路归并已排序的 feed 候选流，取前 maxCount 条（不含游标偏移）。
 * @param {{ candidates: object[], index: number }[]} streams 每源已按 compareFeedItems 降序
 * @param {number} maxCount 最多条数
 * @returns {object[]} 合并后最多 maxCount 条 feed 条目
 */
export function kWayMergeFeedStreams(streams, maxCount) {
	/** @type {object[]} */
	const merged = []
	while (merged.length < maxCount) {
		let best = -1
		for (let i = 0; i < streams.length; i++) {
			const stream = streams[i]
			if (stream.index >= stream.candidates.length) continue
			const head = stream.candidates[stream.index]
			if (best < 0 || compareFeedItems(head, streams[best].candidates[streams[best].index]) > 0)
				best = i
		}
		if (best < 0) break
		merged.push(streams[best].candidates[streams[best].index])
		streams[best].index++
	}
	return merged
}
