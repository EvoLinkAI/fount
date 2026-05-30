import {
	registerTransferKeyDeps,
	unregisterTransferKeyDeps,
} from '../../../../../scripts/p2p/files/transfer_key_registry.mjs'

import { loadVaultGsh } from './gsh/vault.mjs'

const OWNER_ID = 'social'

/**
 * 注册 Social 提供的 vault-wrap transfer key 依赖。
 * @returns {void}
 */
export function registerSocialManifestTransfer() {
	registerTransferKeyDeps(OWNER_ID, {
		/**
		 * @param {string} replicaUsername replica
		 * @param {string} entityHash vault entity
		 * @returns {Promise<Buffer | string | null>} 密钥材料
		 */
		async getVaultH(replicaUsername, entityHash) {
			const state = await loadVaultGsh(replicaUsername, entityHash)
			return state.H
		},
	})
}

/** @returns {void} */
export function unregisterSocialManifestTransfer() {
	unregisterTransferKeyDeps(OWNER_ID)
}
