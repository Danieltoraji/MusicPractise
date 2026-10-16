-- 群组关卡库（docs/39 批次 H5）：用户建群（加入暗号必填 + 加入密码可选），群主及其指定的
-- 审核员审核群内上传；系统管理员可封禁/强制解散。群库复用 hub_items（scope='group'）。
CREATE TABLE groups (
  id TEXT PRIMARY KEY,            -- 群组 ULID（grp_ 前缀）
  name TEXT NOT NULL,             -- NFC + trim ≤32 字
  join_code TEXT NOT NULL UNIQUE COLLATE NOCASE, -- 加入暗号：全局唯一、可检索分享（4–24 字符）
  join_pw_hash TEXT,              -- 加入密码（可空 pbkdf2；空 = 凭暗号即可加入）
  intro TEXT,                     -- 群简介 ≤200 字
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- 群主删号 → 群级联解散
  status TEXT NOT NULL CHECK (status IN ('active', 'banned')) DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'reviewer', 'member')) DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_members_user ON group_members(user_id);

-- 群库条目挂接：scope='group' 时 group_id 非空；(group_id, root_doc_id) 唯一 = 群内同内容一条
ALTER TABLE hub_items ADD COLUMN group_id REFERENCES groups(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX idx_hub_group_root ON hub_items(group_id, root_doc_id);
CREATE INDEX idx_hub_group ON hub_items(group_id);
