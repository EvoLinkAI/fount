/**
 * 群联邦同步水位：离线起始 UTC 月、末帧 tipsHash。
 */
import { writeJsonAtomicSynced } from '../../../../../../../scripts/p2p/dag/storage.mjs'
import { archiveMonthKey } from '../archive/settings.mjs'
import { groupSyncStatePath } from '../lib/paths.mjs'
import { safeReadJson } from '../lib/utils.mjs'

/**
 * @param {object | null} raw 磁盘 JSON
 * @returns {object} 规范化 sync_state
 */
function normalizeSyncState(raw) {
	return {
		offlineStartedAt: Number(raw?.offlineStartedAt) || 0,
		offlineStartUtcMonth: String(raw?.offlineStartUtcMonth || '').trim(),
		tipsHashAtLastSync: String(raw?.tipsHashAtLastSync || '').trim().toLowerCase(),
	}
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @returns {Promise<object>} sync_state
 */
export async function loadGroupSyncState(username, groupId) {
	return normalizeSyncState(await safeReadJson(groupSyncStatePath(username, groupId)))
}

/**
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {object} patch 局部更新
 * @returns {Promise<object>} 写入后的状态
 */
export async function saveGroupSyncState(username, groupId, patch) {
	const next = normalizeSyncState({ ...await loadGroupSyncState(username, groupId), ...patch })
	await writeJsonAtomicSynced(groupSyncStatePath(username, groupId), next)
	return next
}

/**
 * 记录本次离线开始时刻（关客户端/退群前调用）。
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {number} [wallMs] 默认 `Date.now()`
 * @returns {Promise<object>} 更新后的 sync_state
 */
export async function markGroupOfflineStarted(username, groupId, wallMs = Date.now()) {
	const at = Number(wallMs) || Date.now()
	return saveGroupSyncState(username, groupId, {
		offlineStartedAt: at,
		offlineStartUtcMonth: archiveMonthKey(at),
	})
}

/**
 * 上线同步成功后更新末帧 tipsHash。
 * @param {string} username replica
 * @param {string} groupId 群 ID
 * @param {string} tipsHash 本地 `local_tips_hash`
 * @returns {Promise<object>} 更新后的 sync_state
 */
export async function markGroupOnlineSynced(username, groupId, tipsHash) {
	return saveGroupSyncState(username, groupId, {
		tipsHashAtLastSync: String(tipsHash || '').trim().toLowerCase(),
		offlineStartedAt: 0,
	})
}
