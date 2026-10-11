-- docs/31 §4 批次 B3 部分：通关记录（每用户×每关卡一条，单调合并）。
-- upsert 语义：各字段 MAX(旧, 新)——幂等、可交换，多端并发同步收敛一致（worker/handlers/progress.ts）。

CREATE TABLE progress (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level_id   TEXT NOT NULL,
  best_score REAL NOT NULL DEFAULT 0,
  passed     INTEGER NOT NULL DEFAULT 0,   -- 0|1，只升不降
  attempts   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, level_id)
);
