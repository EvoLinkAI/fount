/* global Deno */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { normalizeSealEventIds } from '../src/chat/archive/seal.mjs'
import { archiveMonthKey } from '../src/chat/archive/settings.mjs'

const CP = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const D = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'

Deno.test('normalizeSealEventIds sorts unique hex ids', () => {
	assertEquals(normalizeSealEventIds([B, A, A]), [A, B])
})

Deno.test('topological order tolerates dangling prev after fold (no rewire)', async () => {
	const missing = CP.replace(/c/g, 'e')
	const row = { id: D, type: 'message', prev_event_ids: [missing], hlc: { wall: 4 } }
	const { topologicalCanonicalOrder } = await import('../../../../../scripts/p2p/dag/index.mjs')
	assertEquals(topologicalCanonicalOrder([row]), [D])
	const { ancestorClosureFromTip } = await import('../../../../../scripts/p2p/governance_branch.mjs')
	const byId = new Map([[D, row]])
	assertEquals([...ancestorClosureFromTip(D, byId)], [D])
})

Deno.test('archiveMonthKey uses UTC month boundary', () => {
	assertEquals(archiveMonthKey(Date.UTC(2024, 0, 31, 23, 0)), '2024-01')
	assertEquals(archiveMonthKey(Date.UTC(2024, 1, 1, 0, 0)), '2024-02')
})
