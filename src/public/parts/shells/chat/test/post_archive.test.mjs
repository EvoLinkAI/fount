/* global Deno */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { recomputeHotPostIndex } from '../src/chat/archive/hotPostsIndex.mjs'
import { archiveMonthKey } from '../src/chat/archive/settings.mjs'
import {
	FOLDABLE_PROCESS_EVENT_TYPES,
	shouldDropDagEvent,
} from '../src/chat/dag/foldPolicy.mjs'

Deno.test('shouldDropDagEvent folds process events always', () => {
	const archived = new Set(['m1'])
	const hot = new Set(['m2'])
	assertEquals(shouldDropDagEvent({ type: 'reaction_add', id: 'r1' }, archived, hot, true), true)
	assertEquals(shouldDropDagEvent({ type: 'message_edit', id: 'e1' }, archived, hot, true), true)
	assertEquals(FOLDABLE_PROCESS_EVENT_TYPES.has('pin_message'), true)
})

Deno.test('shouldDropDagEvent keeps hot and unarchived messages', () => {
	const archived = new Set(['m1'])
	const hot = new Set(['m2'])
	assertEquals(shouldDropDagEvent({ type: 'message', id: 'm2' }, archived, hot, true), false)
	assertEquals(shouldDropDagEvent({ type: 'message', id: 'm3' }, archived, hot, true), false)
	assertEquals(shouldDropDagEvent({ type: 'message', id: 'm1' }, archived, hot, true), true)
})

Deno.test('recomputeHotPostIndex earliest and pin context', () => {
	const state = {
		channels: { general: {} },
		messageOverlay: { pins: new Map([['general', ['c']]]) },
	}
	const events = [
		{ id: 'a', type: 'message', channelId: 'general', hlc: { wall: 1 } },
		{ id: 'b', type: 'message', channelId: 'general', hlc: { wall: 2 } },
		{ id: 'c', type: 'message', channelId: 'general', hlc: { wall: 3 } },
		{ id: 'd', type: 'message', channelId: 'general', hlc: { wall: 4 } },
	]
	const hot = recomputeHotPostIndex(state, events, { hotEarliestMessageCount: 2, pinContextMessageCount: 1 })
	assertEquals(hot.earliestByChannel.general, ['a', 'b'])
	assertEquals(hot.pinContexts.general.c, ['b', 'c', 'd'])
})

Deno.test('archiveMonthKey UTC bucket', () => {
	assertEquals(archiveMonthKey(Date.UTC(2024, 5, 15)), '2024-06')
})
