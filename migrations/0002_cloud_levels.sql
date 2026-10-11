-- docs/31 §4 批次 B2 部分：云盘（私有关卡槽位，每用户 ≤10）。
-- payload 存完整 LevelDoc JSON 文本；(user_id, level_id) 唯一——同一关卡重复上传 = 覆盖其云端槽位。

CREATE TABLE cloud_levels (
  id             TEXT PRIMARY KEY,          -- 云端槽位 ULID（cld_ 前缀）
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level_id       TEXT NOT NULL,             -- 关卡信封 id（res_*）
  title          TEXT NOT NULL,             -- 冗余 meta.title 供列表展示
  payload        TEXT NOT NULL,
  bytes          INTEGER NOT NULL,          -- 序列化后字节数（≤512KB，应用层钳制）
  schema_version INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (user_id, level_id)
);
CREATE INDEX idx_cloud_levels_user ON cloud_levels(user_id);
