/**
 * Chat 联邦房间 hooks：注册 social_timeline_put / social_rpc（由 room.mjs 调用）。
 */
import { getSocialFederationHandlers } from '../../../../../../../scripts/p2p/social_federation_registry.mjs'
import { isPlainObject } from '../lib/wireIngress.mjs'

/**
 * @param {string} username 用户
 * @param {object} room Trystero room
 * @param {Map<string, Function>} senderRegistry 出站 action 注册表
 * @returns {void}
 */
export function registerSocialFederationActions(username, room, senderRegistry) {
	const [sendSocialTimelinePut, getSocialTimelinePut] = room.makeAction('social_timeline_put')
	senderRegistry.set('social_timeline_put', sendSocialTimelinePut)

	getSocialTimelinePut(data => {
		if (!isPlainObject(data)) return
		const { ingestTimelinePut } = getSocialFederationHandlers()
		if (!ingestTimelinePut) return
		void ingestTimelinePut(username, data)
	})

	const [sendSocialRpc, getSocialRpc] = room.makeAction('social_rpc')
	senderRegistry.set('social_rpc', sendSocialRpc)
	const [sendSocialRpcResponse, getSocialRpcResponse] = room.makeAction('social_rpc_response')
	senderRegistry.set('social_rpc_response', sendSocialRpcResponse)

	getSocialRpc((data, peerId) => {
		if (!isPlainObject(data)) return
		const { handleRpc } = getSocialFederationHandlers()
		if (!handleRpc) return
		void handleRpc(username, data, (response, targetPeerId) => {
			try { sendSocialRpcResponse(response, targetPeerId) }
			catch { /* peer disconnected */ }
		}, peerId)
	})

	getSocialRpcResponse(data => {
		if (!isPlainObject(data)) return
		const { handleRpcResponse } = getSocialFederationHandlers()
		handleRpcResponse?.(data)
	})
}
