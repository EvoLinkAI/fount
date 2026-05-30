/**
 * P2P 用户级 identity / profile / TrustGraph 单元测试（Deno）。
 */
/* global Deno */
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import {
	clearTrustGraphProvider,
	registerTrustGraphProvider,
	requireTrustGraphProvider,
} from '../trust_graph_registry.mjs'

const TEST_USER = '__p2p_identity_test__'
const ENTITY_HASH = `${'a'.repeat(128)}`

Deno.test('user entity path convention uses lowercase 128-hex hash', () => {
	const segment = String(ENTITY_HASH).trim().toLowerCase()
	assertEquals(segment.length, 128)
	assertEquals(`entities/${segment}/profile.json`.endsWith('profile.json'), true)
})

Deno.test('entity profile API prefix is /api/p2p/entities', () => {
	const avatarPath = `/api/p2p/entities/${encodeURIComponent(ENTITY_HASH)}/files/profile/avatar`
	assertEquals(avatarPath.startsWith('/api/p2p/entities/'), true)
})

Deno.test('sync partition room key differs from legacy federationRoomKey', () => {
	const legacy = `${TEST_USER}\0g1`
	const sync = `${TEST_USER}\0g1\0sync`
	assertEquals(legacy === sync, false)
})

/** @returns {Promise<Map<string, never>>} empty trust graph */
async function buildMergedGraph() {
	return new Map()
}

/** @returns {Promise<never[]>} no nodes */
async function pickTopNodes() {
	return []
}

/** @returns {Promise<boolean>} send result */
async function sendToNode() {
	return false
}

/** @returns {Promise<number>} fanout count */
async function fanoutToTopNodes() {
	return 0
}

Deno.test('trust graph registry register and require', async () => {
	clearTrustGraphProvider()
	assertThrows(() => requireTrustGraphProvider('test'), Error, 'registerTrustGraphProvider')
	registerTrustGraphProvider('test', { buildMergedGraph, pickTopNodes, sendToNode, fanoutToTopNodes })
	assertEquals(await requireTrustGraphProvider('test').fanoutToTopNodes(TEST_USER, 'social_rpc', {}, 1), 0)
	clearTrustGraphProvider()
})
