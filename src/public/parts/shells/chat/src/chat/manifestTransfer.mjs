import { Buffer } from 'node:buffer'

import {
	registerDagManifestPlaintextReader,
	registerTransferKeyDeps,
	unregisterTransferKeyDeps,
} from '../../../../../../scripts/p2p/files/transfer_key_registry.mjs'

import { getDecryptedFile } from './files/groupFiles.mjs'
import { getHByGeneration, getCurrentH } from './gsh/store.mjs'

const OWNER_ID = 'chat'

/**
 * 注册 Chat 提供的 transfer key 与 dag manifest 明文读取。
 * @returns {void}
 */
export function registerChatManifestTransfer() {
	registerTransferKeyDeps(OWNER_ID, {
		/**
		 * @param {string} replicaUsername replica
		 * @param {string} groupId 群 ID
		 * @param {number} [keyGeneration] 密钥代际
		 * @returns {Promise<Buffer | string | null>} 密钥材料
		 */
		async getGroupH(replicaUsername, groupId, keyGeneration) {
			if (keyGeneration != null && Number.isFinite(keyGeneration))
				return getHByGeneration(replicaUsername, groupId, keyGeneration)
			return getCurrentH(replicaUsername, groupId)
		},
	})

	registerDagManifestPlaintextReader(OWNER_ID, async (replicaUsername, manifest) => {
		if (!Array.isArray(manifest.meta?.dagParts) || !manifest.meta?.groupId) return null
		const meta = {
			fileId: manifest.meta.fileId,
			size: manifest.size,
			mimeType: manifest.mimeType,
			contentHash: manifest.contentHash,
			ceMode: manifest.ceMode,
			key_generation: manifest.transferKeyDescriptor?.keyGeneration,
			parts: manifest.meta.dagParts,
		}
		try {
			const plain = await getDecryptedFile(replicaUsername, manifest.meta.groupId, meta)
			return Buffer.from(plain)
		}
		catch {
			return null
		}
	})
}

/** @returns {void} */
export function unregisterChatManifestTransfer() {
	unregisterTransferKeyDeps(OWNER_ID)
}
