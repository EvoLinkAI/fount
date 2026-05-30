import { events } from '../../../../../../../server/events.mjs'

import {
	federationRoomInflight,
	federationRoomRebindGeneration,
	federationRooms,
	groupFederationOwner,
} from './registry.mjs'

/**
 * @param {string} username 用户名
 * @returns {void}
 */
export function invalidateAllFederationRoomsForUser(username) {
	const prefix = `${username}\0`
	for (const key of [...federationRooms.keys()])
		if (key.startsWith(prefix)) {
			federationRooms.delete(key)
			federationRoomInflight.delete(key)
			federationRoomRebindGeneration.set(key, (federationRoomRebindGeneration.get(key) || 0) + 1)
		}

	for (const groupId of [...groupFederationOwner.keys()])
		if (groupFederationOwner.get(groupId) === username)
			groupFederationOwner.delete(groupId)
}

events.on('federation-settings-changed', ({ username }) => {
	invalidateAllFederationRoomsForUser(username)
	void import('../stream/signing.mjs')
		.then(module => module.invalidateStreamSignerCache(username))
		.catch(error => console.warn('federation: invalidateStreamSignerCache failed', error))
})

/**
 *
 */
export {
	ensureFederationDefaults,
	ensureNodeIdentityPubKey,
	getFederationIdentitySecret,
	getFederationSettings,
	saveFederationSettings,
} from '../../../../../../../scripts/p2p/federation/identity.mjs'
