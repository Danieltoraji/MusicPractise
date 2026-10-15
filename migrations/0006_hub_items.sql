-- 关卡库（docs/39 批次 H3）：公共/官方/群组共享域的条目快照 + 审核状态机。
-- 快照制：审核通过时复制内容；作者更新云盘需重新申请（「更新发布」重置 pending）。
-- 源绑定锁定（额度模型 §3）：scope=public 条目处于 pending/published 时锁定云盘源槽位。
CREATE TABLE hub_items (
  id TEXT PRIMARY KEY,            -- 关卡库条目 ULID（hub_ 前缀）
  scope TEXT NOT NULL CHECK (scope IN ('public', 'official', 'group')),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('level', 'series')),
  root_doc_id TEXT NOT NULL,      -- 关卡或系列信封 id；同 scope 内一条（部分唯一索引）
  title TEXT NOT NULL,            -- 快照标题
  level_count INTEGER NOT NULL,   -- 关卡=1；系列=内含关卡数
  bytes INTEGER NOT NULL,
  submitter_id TEXT REFERENCES users(id) ON DELETE SET NULL, -- 官方条目为 NULL
  submitter_name TEXT NOT NULL,   -- 提交时昵称快照（用户删除后仍可展示）
  submitter_note TEXT,            -- 申请留言
  want_featured INTEGER NOT NULL DEFAULT 0, -- 申请精选意愿（H4 启用授予）
  status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'rejected')) DEFAULT 'pending',
  featured INTEGER NOT NULL DEFAULT 0,      -- 精选（仅 scope=public 有意义）
  reject_reason TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at INTEGER,
  published_at INTEGER,
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_hub_scope_status ON hub_items(scope, status);
CREATE INDEX idx_hub_scope_featured ON hub_items(scope, featured);
-- 同一内容在同一公开域只允许一条（含官方）：防他人下载后重复公开
CREATE UNIQUE INDEX idx_hub_root_public ON hub_items(root_doc_id) WHERE scope IN ('public', 'official');

-- 条目内容快照（单关 1 行；系列=系列+专题+关卡多行）
CREATE TABLE hub_item_docs (
  item_id TEXT NOT NULL REFERENCES hub_items(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('series', 'topic', 'level')),
  payload TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (item_id, doc_id)
);
