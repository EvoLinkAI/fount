/**
 * 活跃联邦群隔离区事件周期重放（5 分钟）。
 */
import { releaseQuarantinedEvents } from '../dag/remoteIngest.mjs'

import { groupFederationOwner } from './registry.mjs'

const REPLAY_INTERVAL_MS = 5 * 60 * 1000

let started = false

/**
 * 启动全局 quarantine 重放定时器（幂等）。
 * @returns {void}
 */
export function startFederationQuarantineReplayLoop() {
	if (started) return
	started = true
	setInterval(() => {
		for (const [groupId, username] of groupFederationOwner) {
			if (!username) continue
			void releaseQuarantinedEvents(username, groupId).catch(() => {})
		}
	}, REPLAY_INTERVAL_MS)
}
