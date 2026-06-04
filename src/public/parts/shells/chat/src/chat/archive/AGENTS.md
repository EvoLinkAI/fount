# 冷归档（Chat）

- **月份分桶**：唯一标准 = **UTC** 自然月 `YYYY-MM`（`archiveMonthKey` 使用 `Date.UTC`；禁止 `getMonth()` 等本地时区分桶）。
- **不进 DAG**：封口在 `archive_manifest.json` 的 `seals`；fold 后 `prev` 改接 `checkpoint_event_id`。
- **联邦**：入群带 manifest/seal/monthDigests 索引；`syncMissingArchiveMonths` 按 manifest 补拉缺失月；`fed_archive_month_want` 需 PullAttestation + active 成员；多 peer 应答按 `pickNodeScore` 对 digest 仲裁后写入。
