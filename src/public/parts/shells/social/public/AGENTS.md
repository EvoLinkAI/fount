# Social Shell Frontend Guide

## Trust model

- **Local trust domain**: Social UI、`/api/parts/shells:social/...`、本机 timeline append 与 Chat 联邦 deps 互信。
- **External untrusted**: `social_timeline_put`、`social_rpc`、mailbox 时间线入站；在 `timeline/canonicalizeEvent.mjs` 与 `timeline/sync.mjs` 门禁。

## UI conventions

- 禁止面向用户的硬编码文案；使用 `data-i18n` 与 `zh-CN.json`（`social.*` 键）。
- 优先 `renderTemplate` / `mountTemplate`（`public/src/templates/`），避免大段 `` innerHTML ``。
- 模态框：沿用 `@src/public/pages/scripts/dialog.mjs` 的 `openDialogFromTemplate`（若适用）。

## 联邦 Social

- 远端 `interfaces.social` **仅**经 Trystero `social_rpc`（如 `social_on_mention`），不走 `char_rpc`。

## Related

- [Chat Hub AGENTS.md](../chat/public/hub/AGENTS.md)
- [Shell AGENTS.md](../AGENTS.md)
