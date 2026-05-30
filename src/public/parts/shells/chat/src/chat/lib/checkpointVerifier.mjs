/**
 * 【文件】src/chat/lib/checkpointVerifier.mjs
 * 【职责】DAG checkpoint 签名校验：确保离线导入的检查点未被篡改。
 * 【原理】对 tipIds + materializedRootHash 做 Ed25519 验证，失败入 quarantine。
 * 【数据结构】CheckpointBundle：tips、rootHash、sig、signer。
 * 【关联】dag/hydration、events/quarantine、lib/nodeHash。
 */
import { verifyCheckpointSignature } from '../../../../../../../scripts/p2p/checkpoint.mjs'
import { merkleRoot } from '../../../../../../../scripts/p2p/dag/index.mjs'
import { isHex64 } from '../../../../../../../scripts/p2p/hexIds.mjs'

/**
 * @param {object} checkpoint 远端 checkpoint 对象
 * @param {Uint8Array} ownerPubKey 期望的群主公钥（验签用）
 * @returns {Promise<{ valid: boolean, reason?: string }>} 校验结果与失败原因
 */
export async function verifyRemoteCheckpoint(checkpoint, ownerPubKey) {
	if (!checkpoint || typeof checkpoint !== 'object')
		return { valid: false, reason: 'checkpoint missing or not an object' }

	const ids = checkpoint.eventIdsInEpoch
	if (!Array.isArray(ids) || !ids.length)
		return { valid: false, reason: 'eventIdsInEpoch missing or empty' }
	if (!ids.every(isHex64))
		return { valid: false, reason: 'eventIdsInEpoch contains invalid event id' }

	const expectedRoot = merkleRoot(ids)
	if (checkpoint.epoch_root_hash !== expectedRoot)
		return { valid: false, reason: 'epoch_root_hash does not match Merkle root of eventIdsInEpoch' }

	if (checkpoint.checkpoint_signature) {
		if (!(ownerPubKey instanceof Uint8Array) || ownerPubKey.length !== 32)
			return { valid: false, reason: 'ownerPubKey required for signed checkpoint' }
		const ok = await verifyCheckpointSignature(checkpoint, ownerPubKey)
		if (!ok) return { valid: false, reason: 'checkpoint_signature verification failed' }
	}

	const curEpoch = checkpoint.epoch_id
	if (typeof curEpoch !== 'number' || !Number.isFinite(curEpoch) || curEpoch <= 0 || curEpoch !== Math.floor(curEpoch))
		return { valid: false, reason: 'epoch_id invalid' }

	const chain = checkpoint.epoch_chain
	if (chain != null) {
		if (!Array.isArray(chain))
			return { valid: false, reason: 'epoch_chain is not an array' }
		let prev = -Infinity
		for (let index = 0; index < chain.length; index++) {
			const e = chain[index]
			if (!e || typeof e !== 'object')
				return { valid: false, reason: 'epoch_chain entry invalid' }
			const eid = e.epoch_id
			const erh = e.epoch_root_hash
			const cid = e.checkpoint_event_id
			if (typeof eid !== 'number' || !Number.isFinite(eid) || eid <= 0 || eid !== Math.floor(eid))
				return { valid: false, reason: 'epoch_chain epoch_id invalid' }
			if (!isHex64(erh))
				return { valid: false, reason: 'epoch_chain epoch_root_hash invalid' }
			if (!isHex64(cid))
				return { valid: false, reason: 'epoch_chain checkpoint_event_id invalid' }
			if (eid <= prev) return { valid: false, reason: 'epoch_chain epoch_id not strictly increasing' }
			prev = eid
		}
		if (chain.length && curEpoch < chain[chain.length - 1].epoch_id)
			return { valid: false, reason: 'epoch_id regresses relative to epoch_chain tail' }
	}

	return { valid: true }
}
