import { registerIdentityHandlers } from './identity.mjs'
import { registerRelayHandlers } from './relay.mjs'
import { registerRpcHandlers } from './rpc.mjs'
import { registerSyncHandlers } from './sync.mjs'

/**
 * 注册联邦 Trystero 房间全部入站 handler（send 经 wireAction 写入 senderRegistry）。
 * @param {import('./roomContext.mjs').FederationIdentityContext} roomContext 房间上下文
 * @returns {void}
 */
export function attachFederationRoomHandlers(roomContext) {
	registerIdentityHandlers(roomContext)
	registerRelayHandlers(roomContext)
	registerRpcHandlers(roomContext)
	registerSyncHandlers(roomContext)
}
