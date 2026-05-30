/** @type {{ ingestTimelinePut: ((username: string, payload: object) => Promise<boolean>) | null, handleRpc: ((username: string, payload: object, sendResponse: (response: object, peerId: string) => void, peerId: string) => Promise<void>) | null, handleRpcResponse: ((payload: object) => void) | null }} */
const handlers = {
	ingestTimelinePut: null,
	handleRpc: null,
	handleRpcResponse: null,
}

/**
 * @param {{ ingestTimelinePut?: (username: string, payload: object) => Promise<boolean>, handleRpc?: (username: string, payload: object, sendResponse: (response: object, peerId: string) => void, peerId: string) => Promise<void>, handleRpcResponse?: (payload: object) => void }} nextHandlers social 联邦处理器
 * @returns {void}
 */
export function registerSocialFederationHandlers(nextHandlers) {
	if (nextHandlers?.ingestTimelinePut) handlers.ingestTimelinePut = nextHandlers.ingestTimelinePut
	if (nextHandlers?.handleRpc) handlers.handleRpc = nextHandlers.handleRpc
	if (nextHandlers?.handleRpcResponse) handlers.handleRpcResponse = nextHandlers.handleRpcResponse
}

/** @returns {void} 清空已注册处理器 */
export function clearSocialFederationHandlers() {
	handlers.ingestTimelinePut = null
	handlers.handleRpc = null
	handlers.handleRpcResponse = null
}

/** @returns {typeof handlers} 当前 social 联邦处理器集合 */
export function getSocialFederationHandlers() {
	return handlers
}
