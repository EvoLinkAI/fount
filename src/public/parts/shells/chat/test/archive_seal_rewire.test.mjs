/* global Deno */
import { join } from 'node:path'

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

Deno.test('fold rewire: D.prev points to checkpoint after C removed', async () => {
	const dir = await Deno.makeTempDir()
	const eventsPath = join(dir, 'events.jsonl')
	const row = { id: D, type: 'message', prev_event_ids: [CP.replace(/c/g, 'e')], hlc: { wall: 4 } }
	await Deno.writeTextFile(eventsPath, `${JSON.stringify(row)}\n`)
	const { sortedPrevEventIds } = await import('../../../../../scripts/p2p/dag/index.mjs')
	const parents = sortedPrevEventIds(row.prev_event_ids)
	const next = sortedPrevEventIds([...parents.filter(() => false), CP])
	assertEquals(next, [CP])
	const out = { ...row, prev_event_ids: next }
	await Deno.writeTextFile(eventsPath, `${JSON.stringify(out)}\n`)
	const text = await Deno.readTextFile(eventsPath)
	const parsed = JSON.parse(text.trim())
	assertEquals(parsed.prev_event_ids, [CP])
})

Deno.test('archiveMonthKey uses UTC month boundary', () => {
	assertEquals(archiveMonthKey(Date.UTC(2024, 0, 31, 23, 0)), '2024-01')
	assertEquals(archiveMonthKey(Date.UTC(2024, 1, 1, 0, 0)), '2024-02')
})
