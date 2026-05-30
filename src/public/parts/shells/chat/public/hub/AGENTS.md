# Chat Hub Frontend Guide

## Trust model

- **Local trust domain**: Hub UI, `/api/parts/shells:chat/...`, and in-process server logic are mutually trusted. Do not duplicate federation-style hex/array validation on local API calls or UI state.
- **External untrusted**: Trystero wire, `remoteIngest`, federation discovery/mailbox ingress, remote social payloads. Validate only at those gates (`wireIngress`, `remoteIngest`, `scripts/p2p/schemas/*`).

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
