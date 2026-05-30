/** @type {Map<string, (username: string, groupId: string, hash: string) => Promise<Uint8Array | null>>} */
const federationFetchersByOwner = new Map()

/** @type {Map<string, () => Promise<{ nodeId: string }>>} */
const nodeIdProvidersByOwner = new Map()

/**
 * @param {string} ownerId 注册方
 * @param {(username: string, groupId: string, hash: string) => Promise<Uint8Array | null>} fetcher 联邦 chunk 拉取
 * @returns {void}
 */
export function registerFederationChunkFetcher(ownerId, fetcher) {
	federationFetchersByOwner.set(String(ownerId), fetcher)
}

/**
 * @param {string} ownerId 注册方
 * @param {() => Promise<{ nodeId: string }>} provider nodeId
 * @returns {void}
 */
export function registerNodeIdProvider(ownerId, provider) {
	nodeIdProvidersByOwner.set(String(ownerId), provider)
}

/**
 * @param {string} ownerId 注册方
 * @returns {void}
 */
export function unregisterChunkProviders(ownerId) {
	const key = String(ownerId)
	federationFetchersByOwner.delete(key)
	nodeIdProvidersByOwner.delete(key)
}

/** @returns {void} */
export function clearChunkProviderRegistry() {
	federationFetchersByOwner.clear()
	nodeIdProvidersByOwner.clear()
}

/**
 * @param {string} username 用户
 * @param {string} groupId 群 ID
 * @param {string} hash chunk 哈希
 * @returns {Promise<Uint8Array | null>} 密文块
 */
export async function fetchFederationChunk(username, groupId, hash) {
	for (const fetcher of federationFetchersByOwner.values()) 
		try {
			const u8 = await fetcher(username, groupId, hash)
			if (u8?.byteLength) return u8
		}
		catch { /* next */ }
	
	return null
}

/**
 * @returns {Promise<{ nodeId: string }>} 节点标识
 */
export async function resolveNodeId() {
	for (const provider of nodeIdProvidersByOwner.values()) 
		try {
			return await provider()
		}
		catch { /* next */ }
	
	return { nodeId: 'local' }
}
