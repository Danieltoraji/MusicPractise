-- 云盘文件夹化（docs/39 批次 H2）：系列=文件夹整体上传/下载，占用槽位 = 内含关卡数。
-- 与 cloud_levels 同为「用户私有云盘域」，槽位合并口径 = 关卡槽位数 + Σ(文件夹 level_count)，上限仍为 10。
CREATE TABLE cloud_folders (
  id TEXT PRIMARY KEY,          -- 云端文件夹槽位 ULID（cldf_ 前缀）
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,      -- 系列信封 id（res_*）
  title TEXT NOT NULL,          -- 冗余 meta.title 供列表展示
  level_count INTEGER NOT NULL, -- 内含关卡数 = 槽位占用
  bytes INTEGER NOT NULL,       -- 全部文档 payload 字节之和
  created_at INTEGER NOT NULL,  -- epoch ms
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, folder_id)   -- 同一系列重复上传 = 覆盖更新（docs 与 cloud_levels 同口径）
);
CREATE INDEX idx_cloud_folders_user ON cloud_folders(user_id);

-- 文件夹内文档快照：系列 + 专题 + 关卡信封 JSON 全文（下载/恢复用）
CREATE TABLE cloud_folder_docs (
  folder_id TEXT NOT NULL REFERENCES cloud_folders(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,         -- 信封 id（res_*）
  kind TEXT NOT NULL CHECK (kind IN ('series', 'topic', 'level')),
  payload TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (folder_id, doc_id)
);
