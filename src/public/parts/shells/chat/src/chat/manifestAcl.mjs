import {
	registerManifestAcl,
	unregisterManifestAcl,
} from '../../../../../../../scripts/p2p/entity/files/manifest_acl_registry.mjs'
import { groupIdFromGroupEntity } from '../../../../../../../scripts/p2p/entity/group_entity.mjs'
import { PERMISSIONS } from '../../../../../../../scripts/p2p/permissions.mjs'
import { canInChannel, resolveActiveMemberKeyForLocalUser } from '../../group/access.mjs'

import { getState } from './dag/materialize.mjs'

const OWNER_ID = 'chat'

/**
 * 注册 Chat Shell 提供的群 entity manifest ACL。
 * @returns {void}
 */
export function registerChatManifestAcl() {
	registerManifestAcl('group-entity', OWNER_ID, async (ctx, logicalPath) => {
		const groupId = ctx.manifest?.meta?.groupId
			|| await groupIdFromGroupEntity(ctx.ownerEntityHash, ctx.replicaUsername)
		if (!groupId) return false
		const { state } = await getState(ctx.replicaUsername, groupId)
		const memberKey = await resolveActiveMemberKeyForLocalUser(ctx.replicaUsername, groupId, state)
		if (!memberKey) return false
		if (logicalPath != null) {
			const member = state.members[memberKey]
			const channelId = state.groupSettings?.defaultChannelId || 'default'
			return canInChannel(state, member, PERMISSIONS.UPLOAD_FILES, channelId)
		}
		return true
	})
}

/** @returns {void} */
export function unregisterChatManifestAcl() {
	unregisterManifestAcl('group-entity', OWNER_ID)
}
