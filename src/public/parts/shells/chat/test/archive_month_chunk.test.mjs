/* global Deno */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import {
	assembleArchiveMonthBodyFromParts,
	wirePartsFromEncParts,
} from '../src/chat/archive/monthChunks.mjs'
import { digestArchiveMonthBody } from '../src/chat/archive/monthDigest.mjs'
import { parseFedArchiveMonthResponse } from '../src/chat/federation/archiveMonthWire.mjs'
import { FEDERATION_CHUNK_MAX_BYTES } from '../../../../../scripts/p2p/constants.mjs'
import { encryptPlaintextToMultiParts } from '../../../../../scripts/p2p/files/assemble.mjs'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

Deno.test('wirePartsFromEncParts assigns sequential index', () => {
	const wired = wirePartsFromEncParts([
		{ hash: 'b'.repeat(64), size: 10 },
		{ hash: 'c'.repeat(64), size: 20 },
	])
	assertEquals(wired[0].index, 0)
	assertEquals(wired[1].index, 1)
})

Deno.test('assembleArchiveMonthBodyFromParts roundtrip', () => {
	const line = JSON.stringify({
		eventId: A,
		channelId: 'general',
		timestamp: 1,
		content: { type: 'text', content: 'hello' },
	})
	const body = `${line}\n`
	const enc = encryptPlaintextToMultiParts(Buffer.from(body, 'utf8'), 'plain')
	const parts = wirePartsFromEncParts(enc.parts)
	/** @type {Record<string, Uint8Array>} */
	const fetched = {}
	for (const part of enc.parts) fetched[part.hash] = part.raw
	const restored = assembleArchiveMonthBodyFromParts(parts, fetched)
	assertEquals(restored, body)
	assertEquals(digestArchiveMonthBody(restored).digest, digestArchiveMonthBody(body).digest)
})

Deno.test('multi-chunk split for large archive month body', () => {
	const bigLine = JSON.stringify({
		eventId: A,
		channelId: 'general',
		content: { type: 'text', content: 'x'.repeat(FEDERATION_CHUNK_MAX_BYTES) },
	})
	const enc = encryptPlaintextToMultiParts(Buffer.from(`${bigLine}\n`, 'utf8'), 'plain')
	assertEquals(enc.parts.length > 1, true)
})

Deno.test('parseFedArchiveMonthResponse rejects legacy inline body', () => {
	const digest = 'd'.repeat(64)
	assertEquals(parseFedArchiveMonthResponse({
		requestId: 'r1',
		channelId: 'general',
		utcMonth: '2024-01',
		complete: true,
		digest,
		parts: [{ hash: 'e'.repeat(64), size: 1, index: 0 }],
		body: 'legacy inline',
	}), null)
})

Deno.test('parseFedArchiveMonthResponse accepts chunk meta', () => {
	const digest = 'd'.repeat(64)
	const parsed = parseFedArchiveMonthResponse({
		requestId: 'r1',
		channelId: 'general',
		utcMonth: '2024-01',
		complete: true,
		digest,
		parts: [{ hash: 'e'.repeat(64), size: 1, index: 0 }],
	})
	assertEquals(parsed?.digest, digest)
	assertEquals(parsed?.parts?.length, 1)
})
