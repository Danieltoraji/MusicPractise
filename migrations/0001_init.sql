-- docs/31 §4 批次 B1 部分：账户 + 会话 + 登录限流。
-- cloud_levels / progress / audit_log 分别随 B2 / B3 / B4 各自迁移。

CREATE TABLE users (
  id          TEXT PRIMARY KEY,                       -- 服务端 ULID（usr_ 前缀，crypto 随机）
  nickname    TEXT NOT NULL UNIQUE COLLATE NOCASE,    -- 大小写不敏感唯一；入库前 NFC 归一 + trim
  pw_hash     TEXT NOT NULL,                          -- 'pbkdf2$<iter>$<saltB64>$<hashB64>'，见 worker/password.ts
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at  INTEGER NOT NULL,                       -- epoch ms
  updated_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                      -- SHA-256(token) hex；token 本体只在 HttpOnly Cookie
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL                       -- 30 天滑动续期
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- 登录/注册限流滑窗（docs/31 §6.4）：
-- key = 'login:<ipHash>:<nickname>' 或 'register:<ipHash>'
CREATE TABLE login_attempts (
  key          TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  last_at      INTEGER NOT NULL
);
