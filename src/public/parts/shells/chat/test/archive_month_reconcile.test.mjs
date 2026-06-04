/* global Deno */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import {
	digestArchiveMonthBody,
	inventoryCheck,
	pickArchiveMonthByReputation,
} from '../src/chat/archive/monthDigest.mjs'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** @returns {number} 测试用零分 */
function zeroPickScore() {
	return 0
}

Deno.test('digestArchiveMonthBody is stable for sorted snapshots', () => {
	const body = [
		JSON.stringify({ eventId: B, channelId: 'general', timestamp: 2, content: { type: 'text', content: 'b' } }),
		JSON.stringify({ eventId: A, channelId: 'general', timestamp: 1, content: { type: 'text', content: 'a' } }),
	].join('\n') + '\n'
	const d1 = digestArchiveMonthBody(body).digest
	const d2 = digestArchiveMonthBody(body).digest
	assertEquals(d1, d2)
	assertEquals(d1.length, 64)
})

Deno.test('inventoryCheck rejects foreign eventId', () => {
	const manifest = {
		archivedEventIds: { general: { [A]: '2024-01' } },
	}
	const snaps = [{ eventId: B, channelId: 'general', content: {} }]
	assertEquals(inventoryCheck(manifest, 'general', '2024-01', snaps).ok, false)
})

Deno.test('pickArchiveMonthByReputation accepts two-peer quorum on same digest', async () => {
	const manifest = {
		archivedEventIds: { general: { [A]: '2024-01' } },
	}
	const body = JSON.stringify({
		eventId: A,
		channelId: 'general',
		timestamp: 1,
		content: { type: 'text', content: 'a' },
	}) + '\n'
	const picked = await pickArchiveMonthByReputation(
		[
			{ peerNodeHash: 'c'.repeat(64), body, complete: true },
			{ peerNodeHash: 'd'.repeat(64), body, complete: true },
		],
		'user',
		'g1',
		manifest,
		'general',
		'2024-01',
		{ pickScore: zeroPickScore },
	)
	assertEquals(picked.reason, 'ok')
	assertEquals(picked.digest, digestArchiveMonthBody(body).digest)
})

Deno.test('pickArchiveMonthByReputation prefers manifest monthDigests on tie', async () => {
	const body = JSON.stringify({
		eventId: A,
		channelId: 'general',
		timestamp: 1,
		content: { type: 'text', content: 'a' },
	}) + '\n'
	const digest = digestArchiveMonthBody(body).digest
	const manifest = {
		archivedEventIds: { general: { [A]: '2024-01' } },
		monthDigests: { general: { '2024-01': digest } },
	}
	const picked = await pickArchiveMonthByReputation(
		[{ peerNodeHash: 'c'.repeat(64), body, complete: true }],
		'user',
		'g1',
		manifest,
		'general',
		'2024-01',
		{ pickScore: zeroPickScore },
	)
	assertEquals(picked.reason, 'ok')
	assertEquals(picked.digest, digest)
})
