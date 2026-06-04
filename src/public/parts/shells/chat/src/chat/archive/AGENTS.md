# 冷归档（Chat）

- **月份分桶**：唯一标准 = **UTC** 自然月 `YYYY-MM`（`archiveMonthKey` 使用 `Date.UTC`；禁止 `getMonth()` 等本地时区分桶）。
- **不进 DAG**：封口在 `archive_manifest.json` 的 `seals`；fold 后 `prev` 改接 `checkpoint_event_id`。
- **联邦**：入群带 manifest/seal 索引；按需拉单月 `archive/{channelId}/{YYYY-MM}.jsonl`；回归仅拉 `offlineStartUtcMonth` 一个月。
