/**
 * Chat 联邦加固单元测试（Deno）。
 */
/* global Deno */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import {
	computeTipConsensusScores,
	selectConsensusBranchTip,
} from '../../../../../scripts/p2p/governance_branch.mjs'
import {
	DEFAULT_ICE_SERVERS,
	resolveIceServers,
	sanitizeIceServersForSettings,
} from '../../../../../scripts/p2p/ice_servers.mjs'
import { memberChannelPermissions } from '../../../../../scripts/p2p/materialized_state.mjs'
import {
	messageRateEntityKey,
	resolveMessageRateLimits,
} from '../../../../../scripts/p2p/message_rate_limit.mjs'
import { PERMISSIONS } from '../../../../../scripts/p2p/permissions.mjs'
import { retentionStartIndex } from '../../../../../scripts/p2p/retention_policy.mjs'
import { findStaleUnreachableChannels } from '../src/chat/channel/gc.mjs'
import {
	parseJoinSnapshotRequest,
	parseJoinSnapshotResponse,
} from '../src/chat/federation/joinSnapshotWire.mjs'
import {
	partitionForOutboundEvent,
	resolveNodePartitionIds,
} from '../src/chat/federation/partitions.mjs'

const GC_IDLE_MS = 30 * 24 * 3600 * 1000

Deno.test('messageRateEntityKey distinguishes user and char', () => {
	assertEquals(messageRateEntityKey({ sender: 'a'.repeat(64) }), 'a'.repeat(64))
	assertEquals(messageRateEntityKey({ charId: 'bot1', sender: 'a'.repeat(64) }), 'char:bot1')
})

Deno.test('resolveMessageRateLimits clamps values', () => {
	const limits = resolveMessageRateLimits({ messageRateLimitPerMin: 999, messageRateLimitWindowMs: 1000 })
	assertEquals(limits.perMin, 120)
	assertEquals(limits.windowMs, 10_000)
})

Deno.test('hasBypassRateLimit respects BYPASS_RATE_LIMIT permission', () => {
	const sender = 'b'.repeat(64)
	const state = {
		members: {
			[sender]: {
				status: 'active',
				roles: ['admin'],
			},
		},
		roles: {
			admin: {
				permissions: { [PERMISSIONS.BYPASS_RATE_LIMIT]: true },
			},
		},
		channels: { default: {} },
	}
	assertEquals(memberChannelPermissions(state, sender, 'default')[PERMISSIONS.BYPASS_RATE_LIMIT], true)
})

Deno.test('retentionStartIndex respects depth cutoff', () => {
	const order = ['e1', 'e2', 'e3', 'e4']
	const byId = new Map(order.map((id, i) => [id, { id, hlc: { wall: i * 1000 } }]))
	const start = retentionStartIndex(order, byId, { maxDepth: 2, cutoffWall: 0 })
	assertEquals(start, 2)
})

Deno.test('joinSnapshot wire parse', () => {
	assertEquals(parseJoinSnapshotRequest(null), null)
	const req = parseJoinSnapshotRequest({
		requestId: 'r1',
		requesterId: 'node-a',
		groupId: 'g1',
	})
	assertEquals(req?.groupId, 'g1')
	const res = parseJoinSnapshotResponse({
		requestId: 'r1',
		requesterId: 'node-a',
		responderNodeId: 'node-b',
		checkpoint: { tipsHash: 'abc' },
	})
	assertEquals(res?.responderNodeId, 'node-b')
})

Deno.test('resolveIceServers filters invalid URLs', () => {
	const servers = resolveIceServers({
		iceServers: [
			{ urls: 'http://bad' },
			{ urls: 'stun:stun.example.com:3478' },
			{ urls: 'turn:turn.example.com', username: 'u', credential: 'p' },
		],
	})
	assertEquals(servers.length, 2)
	assertEquals(servers[0].urls, 'stun:stun.example.com:3478')
})

Deno.test('sanitizeIceServers requires credential pair', () => {
	const out = sanitizeIceServersForSettings([
		{ urls: 'turn:t.example.com', username: 'u' },
	])
	assertEquals(out[0]?.urls, DEFAULT_ICE_SERVERS[0].urls)
})

Deno.test('consensus branch prefers higher governance count', () => {
	const a1 = 'a'.repeat(64)
	const t1 = 'b'.repeat(64)
	const b1 = 'c'.repeat(64)
	const t2 = 'd'.repeat(64)
	const tips = [t1, t2]
	const byId = new Map([
		[a1, { id: a1, type: 'role_create', prev_event_ids: [] }],
		[t1, { id: t1, type: 'message', prev_event_ids: [a1] }],
		[b1, { id: b1, type: 'message', prev_event_ids: [] }],
		[t2, { id: t2, type: 'message', prev_event_ids: [b1] }],
	])
	assertEquals(selectConsensusBranchTip(tips, byId), t1)
	const scores = computeTipConsensusScores(tips, byId)
	assertEquals(scores[t1] > scores[t2], true)
})

Deno.test('partition mapping routes channel messages to ch-xx', () => {
	const settings = { federationPartitionCount: 8 }
	const partitions = resolveNodePartitionIds(settings, 'channel-alpha')
	assertEquals(partitions.includes('sync'), true)
	const pid = partitionForOutboundEvent('message', 'channel-alpha', settings)
	assertEquals(pid.startsWith('ch-'), true)
})

Deno.test('mergeChannelMessagesForDisplay marks edited messages', async () => {
	const { mergeChannelMessagesForDisplay } = await import('../src/chat/lib/messageMerge.mjs')
	const baseId = 'a'.repeat(64)
	const editId = 'b'.repeat(64)
	const rows = [
		{ type: 'message', eventId: baseId, content: { type: 'text', content: 'hi' } },
		{
			type: 'message_edit',
			eventId: editId,
			content: { targetId: baseId, newContent: { type: 'text', content: 'edited' } },
		},
	]
	const merged = mergeChannelMessagesForDisplay(rows)
	assertEquals(merged.length, 1)
	assertEquals(merged[0].wasEdited, true)
	assertEquals(merged[0].content.content, 'edited')
})

Deno.test('channel GC skips default channel', () => {
	const nowMs = 1_700_000_000_000
	const state = {
		groupSettings: { defaultChannelId: 'default' },
		channels: { default: { id: 'default' } },
	}
	assertEquals(findStaleUnreachableChannels(state, [], nowMs), [])
})

Deno.test('channel GC skips reachable stale child', () => {
	const nowMs = 1_700_000_000_000
	const state = {
		groupSettings: { defaultChannelId: 'default' },
		channels: {
			default: { id: 'default' },
			child: { id: 'child', parentChannelId: 'default' },
		},
	}
	const events = [{
		type: 'message',
		channelId: 'child',
		hlc: { wall: nowMs - GC_IDLE_MS - 1 },
	}]
	assertEquals(findStaleUnreachableChannels(state, events, nowMs), [])
})

Deno.test('channel GC collects unreachable stale channel', () => {
	const nowMs = 1_700_000_000_000
	const state = {
		groupSettings: { defaultChannelId: 'default' },
		channels: {
			default: { id: 'default' },
			orphan: { id: 'orphan' },
		},
	}
	const events = [{
		type: 'message',
		channelId: 'orphan',
		hlc: { wall: nowMs - GC_IDLE_MS - 1 },
	}]
	assertEquals(findStaleUnreachableChannels(state, events, nowMs), ['orphan'])
})

Deno.test('channel GC skips unreachable but recently active', () => {
	const nowMs = 1_700_000_000_000
	const state = {
		groupSettings: { defaultChannelId: 'default' },
		channels: {
			default: { id: 'default' },
			orphan: { id: 'orphan' },
		},
	}
	const events = [{ type: 'message', channelId: 'orphan', hlc: { wall: nowMs - 1000 } }]
	assertEquals(findStaleUnreachableChannels(state, events, nowMs), [])
})

Deno.test('channel GC skips channel linked from list manualItems', () => {
	const nowMs = 1_700_000_000_000
	const state = {
		groupSettings: { defaultChannelId: 'default' },
		channels: {
			default: {
				id: 'default',
				type: 'list',
				manualItems: [{ targetChannelId: 'linked' }],
			},
			linked: { id: 'linked' },
			orphan: { id: 'orphan' },
		},
	}
	const events = [
		{ type: 'message', channelId: 'linked', hlc: { wall: nowMs - GC_IDLE_MS - 1 } },
		{ type: 'message', channelId: 'orphan', hlc: { wall: nowMs - GC_IDLE_MS - 1 } },
	]
	assertEquals(findStaleUnreachableChannels(state, events, nowMs), ['orphan'])
})
