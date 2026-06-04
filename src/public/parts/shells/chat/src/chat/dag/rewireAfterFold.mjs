/**
 * @deprecated fold 后不得改写 events.jsonl 中的 prev_event_ids（会破坏 id/签名）。
 * 悬空父指针由 topologicalCanonicalOrder / ancestorClosureFromTip 在图内忽略。
 */

/**
 * @param {string} _username replica
 * @param {string} _groupId 群 ID
 * @param {string} _checkpointTipId checkpoint_event_id
 * @returns {Promise<{ rewired: number }>} 恒为 0
 */
export async function rewireDagPrevToCheckpointTip(_username, _groupId, _checkpointTipId) {
	return { rewired: 0 }
}
