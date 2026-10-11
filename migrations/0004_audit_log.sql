-- docs/31 §4 批次 B4 部分：审计日志（管理操作逐条落审计，detail 存变更摘要、绝不含密码）。

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,              -- aud_ ULID
  actor_id    TEXT,                          -- 操作者（admin）id；操作者被删后留空引用
  action      TEXT NOT NULL,                 -- 'admin.disable_user' / 'admin.reset_password' / 'admin.delete_level' …
  target_type TEXT NOT NULL,                 -- 'user' | 'cloud_level'
  target_id   TEXT NOT NULL,
  detail      TEXT,                          -- JSON 摘要（不含敏感字段）
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
