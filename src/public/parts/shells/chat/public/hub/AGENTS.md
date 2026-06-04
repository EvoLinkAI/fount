# Chat Hub Frontend Guide

## Trust model

- **Local trust domain**: Hub UI, `/api/parts/shells:chat/...`, and in-process server logic are mutually trusted. Do not duplicate federation-style hex/array validation on local API calls or UI state.
- **External untrusted**: Trystero wire, `remoteIngest`, federation discovery/mailbox ingress, remote social payloads. Validate only at those gates (`scripts/p2p/wire_ingress.mjs`, `remoteIngest`, `scripts/p2p/schemas/*`).

## Streaming AV

- **Default (no `streamingSfuWss`)**: WebCodecs + server **av-relay** (`codecsAv.mjs`, `/ws/.../av-relay/:roomId`). Suited to more viewers per publisher than browser WebRTC mesh.
- **With external SFU URL**: iframe/embed path via `renderStreamingChannel`.
- WebRTC mesh (`streaming.mjs` / group WS signaling) remains for peer-to-peer experiments; Hub join flow uses relay unless SFU is configured.

## UI conventions

- No hardcoded user-visible strings in HTML/JS; use `data-i18n` and `zh-CN.json` (do not run `update-locales.py` in routine PRs).
- Prefer `renderTemplate` / `mountTemplate` over inline `innerHTML` for markup.
- Modals: use `openDialogFromTemplate` from `@src/public/pages/scripts/dialog.mjs` when available.
- State: `hubStore` in `core/state.mjs`; banner visibility via `core/bindings.mjs` when wired.

## Related

- [Shell AGENTS.md](../../AGENTS.md)
- [Pages AGENTS.md](../../../../pages/AGENTS.md)

## Message storage (hot / archive / DAG)

- **Hot**: `checkpoint.json` (`hot_posts` earliest N + pin ±N), `messages/{channelId}.jsonl` slim cache.
- **Cold archive**: `groups/{groupId}/archive/{channelId}/{YYYY-MM}.jsonl` — local plaintext `PostSnapshot` (final content, reactions, display name/avatar).
- **DAG WAL**: `events.jsonl` — foldable process events (`message_edit`, reactions, pin/unpin); archived `message` rows removed only after cold archive + `dagFoldAfterArchive`.
- **Read path**: `listChannelMessages({ includeArchive: true })` merges hot + archive; `before` pagination may call `requestChannelHistoryFromPeers` when local miss.
- **Cleanup**: admins delete cold months via settings UI → `DELETE .../archive?before=YYYY-MM` (does not silent-prune DAG).
- **Display**: Hub prefers `content.displayName` / `content.displayAvatar` on archived or folded posts, then live profile.
- **Message navigation**: `messages/channelMessageStore.mjs` owns fetch/merge by `eventId` (`ensureMessageLoaded`); `messages.mjs` only scrolls/highlights DOM (`scrollToMessageEventId`).
