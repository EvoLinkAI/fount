import {
	clearSocialFederationHandlers,
	registerSocialFederationHandlers,
} from '../../../../scripts/p2p/social_federation_registry.mjs'

import { setEndpoints } from './src/endpoints.mjs'
import {
	handleIncomingSocialRpc,
	handleIncomingSocialRpcResponse,
	ingestSocialTimelinePut,
} from './src/federation/relay.mjs'
import { registerSocialManifestAcl, unregisterSocialManifestAcl } from './src/manifestAcl.mjs'
import { registerSocialManifestTransfer, unregisterSocialManifestTransfer } from './src/manifestTransfer.mjs'

const { info } = (await import('./locales.json', { with: { type: 'json' } })).default

/**
 * Social shell：账号 = Chat 联邦 P2P 实体（用户 identity 或本机 agent entityHash），无需单独注册。
 * @type {import('../../../../../src/decl/shellAPI.ts').shellAPI_t}
 */
export default {
	info,
	/**
	 * 加载 Social shell 并注册 HTTP/WS 路由。
	 * @param {object} root0 参数
	 * @param {import('npm:websocket-express').Router} root0.router Express 路由
	 * @returns {void}
	 */
	Load: ({ router }) => {
		registerSocialManifestAcl()
		registerSocialManifestTransfer()
		registerSocialFederationHandlers({
			ingestTimelinePut: ingestSocialTimelinePut,
			handleRpc: handleIncomingSocialRpc,
			handleRpcResponse: handleIncomingSocialRpcResponse,
		})
		setEndpoints(router)
	},
	/** 卸载 Social shell。 */
	Unload: () => {
		clearSocialFederationHandlers()
		unregisterSocialManifestAcl()
		unregisterSocialManifestTransfer()
	},
	interfaces: {
		web: {},
	},
}
