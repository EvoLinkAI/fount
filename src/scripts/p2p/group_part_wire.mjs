import { attachPartWire } from './part_wire.mjs'
import { isPlainObject } from './wire_ingress.mjs'

/**
 * @param {object} data part_invoke 载荷
 * @param {string} groupId 群 ID
 * @returns {object} 注入 groupId 后的载荷
 */
function injectGroupContext(data, groupId) {
	const withTop = data.groupId ? data : { ...data, groupId }
	if (!isPlainObject(withTop.invoke) || withTop.invoke.groupId) return withTop
	return { ...withTop, invoke: { ...withTop.invoke, groupId } }
}

/**
 * @param {import('./part_wire.mjs').PartWireAdapter} wire 底层适配器
 * @param {string} groupId 群 ID
 * @returns {import('./part_wire.mjs').PartWireAdapter['on']} 注入 groupId 的 on 包装
 */
function wrapWireOn(wire, groupId) {
	return (name, handler) => {
		wire.on(name, (data, peerId) => {
			if (!isPlainObject(data)) return
			handler(injectGroupContext(data, groupId), peerId)
		})
	}
}

/**
 * 群联邦房间挂载 part_wire（Adapter 层注入 groupId）。
 * @param {string} username replica 登录名
 * @param {string} groupId 群 ID
 * @param {import('./part_wire.mjs').PartWireAdapter} wire Trystero 适配器
 * @param {{ allowPartInvoke?: (payload: object) => boolean }} [options] 入站过滤
 * @returns {void}
 */
export function attachGroupPartWire(username, groupId, wire, options = {}) {
	attachPartWire(username, {
		send: wire.send.bind(wire),
		on: wrapWireOn(wire, groupId),
	}, options)
}
