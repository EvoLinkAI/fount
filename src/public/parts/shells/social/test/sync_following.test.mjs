/**
 * syncFollowing 模块冒烟（避免 import 整条联邦链）。
 */
/* global Deno */
import { assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'

Deno.test('syncFollowingTimelines is defined in source', async () => {
	const url = new URL('../src/federation/syncFollowing.mjs', import.meta.url)
	const text = await Deno.readTextFile(url)
	assert(text.includes('export async function syncFollowingTimelines'))
})
