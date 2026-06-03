/**
 * 联邦房间 handler 依赖：按子域拆分 typedef，避免 roomContext 上帝对象无文档膨胀。
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
 *   username: string,
 *   groupId: string,
 *   nodeHash: string,
 *   fedOut: object,
 *   isBlockedPeer: (subject: string) => boolean,
 * }} FederationRelayContext
 */

/**
 * @typedef {FederationRoomWireContext & {
 *   username: string,
 *   groupId: string,
 *   key: string,
 *   nodeHash: string,
 *   groupSettings: object,
 *   room: object,
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
 *   username: string,
 *   groupId: string,
 *   nodeHash: string,
 *   groupSettings: object,
 *   fedOut: object,
 *   peerToNode: Map<string, string>,
 *   isBlockedPeer: (subject: string) => boolean,
 * }} FederationSyncContext
 */

/**
 * @typedef {FederationRoomWireContext & {
 *   username: string,
 *   groupId: string,
 *   key: string,
 *   room: object,
 *   fedOut: object,
 *   rtcLimits: object,
 * }} FederationRpcContext
 */

/**
 * @param {FederationIdentityContext & FederationRelayContext & FederationSyncContext & FederationRpcContext} params 房间 join 期组装的依赖
 * @returns {typeof params} 完整房间 handler 上下文
 */
export function createFederationRoomContext(params) {
	return params
}
