/**
 * Social 事件分发：@ 任意 P2P 实体；本地 agent 通过 char.interfaces.social 响应。
 * 无 social 面板的老角色在加载时注入 default_interface（见 lib/charSocial.mjs）。
 * Social 账号 = Chat 账号 = fount P2P 实体，无需单独注册。
 */
import { loadPart } from '../../../../../server/parts_loader.mjs'

import { getEntityProfile } from './feed.mjs'
import { listReplicaUsernamesFollowing } from './following.mjs'
import { ensureCharSocialInterface } from './lib/charSocial.mjs'
import { listLocalAgentEntities, resolveSocialEntity } from './lib/entityResolve.mjs'
import { extractMentionEntityHashes } from './lib/mentions.mjs'
import { mentionSourceText, postTextForNotification } from './lib/postMentionText.mjs'
import { appendTimelineEvent } from './timeline/append.mjs'
import { fanoutTimelineEvent } from './timeline/publish.mjs'

/** 重导出帖子正文工具（@ 扫描与通知可见文本）。 */
export { mentionSourceText, postTextForNotification } from './lib/postMentionText.mjs'

/**
 * 解析 entityHash 对应的展示名。
 * @param {string} entityHash 128 位 entityHash
 * @param {string} [replicaUsername] 查询 profile 的 replica
 * @returns {Promise<string>} 展示名或 hash 缩写
 */
async function displayNameForEntity(entityHash, replicaUsername) {
	if (replicaUsername) {
		const profile = await getEntityProfile(replicaUsername, entityHash)
		if (profile?.displayName || profile?.name)
			return profile.displayName || profile.name
	}
	return `${entityHash.slice(0, 8)}…${entityHash.slice(-4)}`
}

/**
 * 调用角色 `interfaces.social` 上的指定处理器。
 * @param {string} username replica 登录名
 * @param {string} charPartName chars/ 下目录名
 * @param {string} method interfaces.social 方法名
 * @param {object} event 事件载荷
 * @returns {Promise<{ text?: string, skip?: boolean } | null>} 处理器结果
 */
async function invokeCharSocialInterface(username, charPartName, method, event) {
	const char = await ensureCharSocialInterface(username, charPartName)
	const handler = char?.interfaces?.social?.[method]
	if (typeof handler !== 'function') return null
	return normalizeSocialHandlerResult(await handler({
		username,
		charPartName,
		...event,
	}))
}

/**
 * @param {unknown} socialHandlerResult social 接口返回值
 * @returns {{ text?: string, skip?: boolean }} 统一结果
 */
function normalizeSocialHandlerResult(socialHandlerResult) {
	if (socialHandlerResult == null) return { skip: true }
	if (typeof socialHandlerResult === 'string') return { text: socialHandlerResult }
	if (typeof socialHandlerResult === 'object') return socialHandlerResult
	return { skip: true }
}

/**
 * 以指定实体身份发布公开回复并联邦 fanout。
 * @param {string} username 代写时间线的 replica 登录名
 * @param {string} authorEntityHash 回复作者 entityHash
 * @param {object} content 帖子 content
 * @param {string | null} [charPartName] 本地 agent 时 chars 目录名
 * @returns {Promise<object>} 签名 post 事件
 */
async function publishEntityReply(username, authorEntityHash, content, charPartName = null) {
	const signed = await appendTimelineEvent(username, authorEntityHash, {
		type: 'post',
		charId: charPartName,
		content,
	})
	await fanoutTimelineEvent(username, authorEntityHash, signed)
	return signed
}

/**
 * 本机 replica 上执行 OnMention（供 social_rpc 入站）。
 * @param {string} hostingUsername 托管 replica
 * @param {object} rpc RPC 体
 * @returns {Promise<{ ok: boolean, published?: boolean }>} 处理结果
 */
export async function processSocialOnMentionRpc(hostingUsername, rpc) {
	const target = resolveSocialEntity(rpc.targetEntityHash, hostingUsername)
	if (!target?.local || target.kind !== 'agent' || !target.replicaUsername || !target.charPartName)
		return { ok: false }
	const custom = await invokeCharSocialInterface(
		target.replicaUsername,
		target.charPartName,
		'OnMention',
		{
			authorEntityHash: rpc.authorEntityHash,
			authorDisplayName: rpc.authorDisplayName,
			postId: rpc.postId,
			postText: rpc.postText,
			mentionedEntityHash: target.entityHash,
			replyTo: rpc.replyTo,
			lang: rpc.lang,
		},
	)
	if (!custom || custom.skip || !custom.text) return { ok: true, published: false }
	await publishEntityReply(
		target.replicaUsername,
		target.entityHash,
		{ text: custom.text, replyTo: rpc.replyTo, visibility: 'public', lang: rpc.lang },
		target.charPartName,
	)
	return { ok: true, published: true }
}

/**
 * 帖子 @ 提及分发：目标为任意 P2P 实体；本机托管 agent 经 social 接口（含默认面板）自动回复。
 * @param {string} posterUsername 发帖 replica
 * @param {string} authorEntityHash 作者 entityHash
 * @param {object} post 签名 post
 * @returns {Promise<void>} 无返回值
 */
export async function dispatchPostMentions(posterUsername, authorEntityHash, post) {
	const mentions = extractMentionEntityHashes(mentionSourceText(post))
	if (!mentions.length) return

	const notifyText = postTextForNotification(post)
	const authorLabel = await displayNameForEntity(authorEntityHash, posterUsername)
	const replyTo = { entityHash: authorEntityHash, postId: post.id }
	const lang = post.content?.lang || 'zh-CN'

	for (const targetHash of mentions) {
		if (targetHash === authorEntityHash.toLowerCase()) continue
		const target = resolveSocialEntity(targetHash)
		if (target?.local && target.kind === 'agent' && target.replicaUsername && target.charPartName) {
			const custom = await invokeCharSocialInterface(
				target.replicaUsername,
				target.charPartName,
				'OnMention',
				{
					authorEntityHash,
					authorDisplayName: authorLabel,
					postId: post.id,
					postText: notifyText,
					mentionedEntityHash: target.entityHash,
					replyTo,
					lang,
				},
			)
			if (!custom || custom.skip || !custom.text) continue
			await publishEntityReply(
				target.replicaUsername,
				target.entityHash,
				{ text: custom.text, replyTo, visibility: 'public', lang },
				target.charPartName,
			)
			continue
		}

		const { requestSocialRpcFromNetwork } = await import('./federation/relay.mjs')
		void requestSocialRpcFromNetwork(posterUsername, {
			type: 'social_on_mention',
			targetEntityHash: targetHash,
			authorEntityHash,
			authorDisplayName: authorLabel,
			postId: post.id,
			postText: notifyText,
			replyTo,
			lang,
		}).catch(err => console.error('social_rpc social_on_mention failed', err))
	}
}

/**
 * 新关注事件：目标为本地 agent 时调用 OnFollow。
 * @param {string} followerUsername 关注者 replica
 * @param {string} followerEntityHash 关注者 entityHash
 * @param {string} targetEntityHash 被关注 entityHash
 * @returns {Promise<void>}
 */
export async function dispatchFollowEvent(followerUsername, followerEntityHash, targetEntityHash) {
	const target = resolveSocialEntity(targetEntityHash)
	if (!target?.local || target.kind !== 'agent' || !target.replicaUsername || !target.charPartName)
		return

	await invokeCharSocialInterface(
		target.replicaUsername,
		target.charPartName,
		'OnFollow',
		{
			followerEntityHash,
			followerUsername,
			targetEntityHash: target.entityHash,
		},
	)
}

/**
 * 所关注实体发新帖：通知各 replica 上显式实现 OnFollowerUpdate 的本地 agent（无默认实现）。
 * @param {string} authorEntityHash 发帖作者 entityHash
 * @param {object} post 签名 post 事件
 * @returns {Promise<void>}
 */
export async function dispatchPostFollowerUpdates(authorEntityHash, post) {
	const author = String(authorEntityHash || '').toLowerCase()
	if (!author || post?.type !== 'post') return

	const notifyText = postTextForNotification(post)
	const replyTo = { entityHash: author, postId: post.id }
	const lang = post.content?.lang || 'zh-CN'

	for (const viewerUsername of await listReplicaUsernamesFollowing(author))
		for (const { entityHash: agentHash, charPartName } of listLocalAgentEntities(viewerUsername)) {
			const char = await loadPart(viewerUsername, `chars/${charPartName}`)
			const handler = char?.interfaces?.social?.OnFollowerUpdate
			if (typeof handler !== 'function') continue

			const result = await handler({
				username: viewerUsername,
				charPartName,
				authorEntityHash: author,
				postId: post.id,
				postText: notifyText,
				post,
				viewerUsername,
			})
			const custom = normalizeSocialHandlerResult(result)

			if (!custom || custom.skip || !custom.text) continue
			await publishEntityReply(
				viewerUsername,
				agentHash,
				{ text: custom.text, replyTo, visibility: 'public', lang },
				charPartName,
			)
		}

}
