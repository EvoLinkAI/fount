import {
	registerFederationChunkFetcher,
	registerNodeIdProvider,
	unregisterChunkProviders,
} from '../../../../../../scripts/p2p/files/chunk_provider_registry.mjs'

import { fetchCiphertextFromFederation } from './federation/chunks.mjs'
import { requireDagDeps } from './federation/deps.mjs'

const OWNER_ID = 'chat'

/**
 * 注册 Chat 联邦 chunk 与 nodeId 提供者。
 * @returns {void}
 */
export function registerChatChunkProviders() {
	registerFederationChunkFetcher(OWNER_ID, fetchCiphertextFromFederation)
	registerNodeIdProvider(OWNER_ID, () => requireDagDeps())
}

/** @returns {void} */
export function unregisterChatChunkProviders() {
	unregisterChunkProviders(OWNER_ID)
}
