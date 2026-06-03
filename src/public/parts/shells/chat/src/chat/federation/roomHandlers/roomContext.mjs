/**
 * 联邦房间 handler 依赖：按子域拆分 typedef + 构造期 pick，避免 handler 接触无关可变状态。
 */

/**
 * @typedef {object} FederationWireBinding
 * @property {ReturnType<import('../../../../../../../../scripts/p2p/trystero_session.mjs').createTrysteroActionRegistry>} wireActions
 * @property {Map<string, Function>} senderRegistry
 */

/**
 * @typedef {FederationWireBinding & {
 *   username: string,
 *   groupId: string,
 *   room: object,
 *   getActionSender: (name: string) => Function,
 *   getActionReceiver: (name: string) => Function,
 * }} FederationRoomWireContext
 */

/**
 * @typedef {FederationRoomWireContext & {
 *   nodeHash: string,
 *   fedOut: object,
 *   isBlockedPeer: (subject: string) => boolean,
 * }} FederationRelayContext
 */

/**
 * @typedef {FederationRoomWireContext & {
 *   key: string,
 *   nodeHash: string,
 *   groupSettings: object,
 *   fedOut: object,
 *   rtcLimits: object,
 *   peerToNode: Map<string, string>,
 *   nodeToPeer: Map<string, string>,
 *   ensureFederationPartitionRoom: Function,
 *   getSlot: () => import('../federationSlot.mjs').FederationSlot | null,
 * }} FederationIdentityContext
 */

/**
 * @typedef {FederationRoomWireContext & {
 *   nodeHash: string,
 *   groupSettings: object,
 *   fedOut: object,
 *   peerToNode: Map<string, string>,
 *   isBlockedPeer: (subject: string) => boolean,
 * }} FederationSyncContext
 */

/**
 * @typedef {FederationRoomWireContext & {
 *   key: string,
 *   fedOut: object,
 *   rtcLimits: object,
 * }} FederationRpcContext
 */

/**
 * @typedef {object} FederationRoomHandlerBundle
 * @property {FederationIdentityContext} identity
 * @property {FederationRelayContext} relay
 * @property {FederationSyncContext} sync
 * @property {FederationRpcContext} rpc
 */

/**
 * @param {FederationRoomWireContext} ctx 房间 join 期 wire 绑定
 * @returns {FederationRoomWireContext} Trystero wire 最小子集
 */
export function pickWireContext(ctx) {
	return {
		username: ctx.username,
		groupId: ctx.groupId,
		room: ctx.room,
		wireActions: ctx.wireActions,
		senderRegistry: ctx.senderRegistry,
		getActionSender: ctx.getActionSender,
		getActionReceiver: ctx.getActionReceiver,
	}
}

/**
 * @param {FederationIdentityContext} ctx 完整 identity 依赖
 * @returns {FederationIdentityContext} identity handler 依赖
 */
export function pickIdentityContext(ctx) {
	return {
		...pickWireContext(ctx),
		key: ctx.key,
		nodeHash: ctx.nodeHash,
		groupSettings: ctx.groupSettings,
		fedOut: ctx.fedOut,
		rtcLimits: ctx.rtcLimits,
		peerToNode: ctx.peerToNode,
		nodeToPeer: ctx.nodeToPeer,
		ensureFederationPartitionRoom: ctx.ensureFederationPartitionRoom,
		getSlot: ctx.getSlot,
	}
}

/**
 * @param {FederationRelayContext} ctx 完整 relay 依赖
 * @returns {FederationRelayContext} relay handler 依赖
 */
export function pickRelayContext(ctx) {
	return {
		...pickWireContext(ctx),
		nodeHash: ctx.nodeHash,
		fedOut: ctx.fedOut,
		isBlockedPeer: ctx.isBlockedPeer,
	}
}

/**
 * @param {FederationSyncContext} ctx 完整 sync 依赖
 * @returns {FederationSyncContext} sync handler 依赖
 */
export function pickSyncContext(ctx) {
	return {
		...pickWireContext(ctx),
		nodeHash: ctx.nodeHash,
		groupSettings: ctx.groupSettings,
		fedOut: ctx.fedOut,
		peerToNode: ctx.peerToNode,
		isBlockedPeer: ctx.isBlockedPeer,
	}
}

/**
 * @param {FederationRpcContext} ctx 完整 rpc 依赖
 * @returns {FederationRpcContext} rpc handler 依赖
 */
export function pickRpcContext(ctx) {
	return {
		...pickWireContext(ctx),
		key: ctx.key,
		fedOut: ctx.fedOut,
		rtcLimits: ctx.rtcLimits,
	}
}

/**
 * @param {FederationIdentityContext & FederationRelayContext & FederationSyncContext & FederationRpcContext} params join 期全量依赖
 * @returns {FederationRoomHandlerBundle} 各 handler 最小依赖包
 */
export function createFederationRoomHandlerBundle(params) {
	return {
		identity: pickIdentityContext(params),
		relay: pickRelayContext(params),
		sync: pickSyncContext(params),
		rpc: pickRpcContext(params),
	}
}
