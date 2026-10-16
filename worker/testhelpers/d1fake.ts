import type { D1Database, D1PreparedStatement } from '../types'

export type Row = Record<string, unknown>

export interface SessionRow {
  id: string
  user_id: string
  created_at: number
  last_seen_at: number
  expires_at: number
}

export interface LoginAttemptRow {
  key: string
  fail_count: number
  window_start: number
  last_at: number
}

export interface CloudLevelRow {
  id: string
  user_id: string
  level_id: string
  title: string
  payload: string
  bytes: number
  schema_version: number
  created_at: number
  updated_at: number
}

export interface ProgressRow {
  user_id: string
  level_id: string
  best_score: number
  passed: number
  attempts: number
  updated_at: number
}

export interface AuditRow {
  id: string
  actor_id: string | null
  action: string
  target_type: string
  target_id: string
  detail: string | null
  created_at: number
}

export interface CloudFolderRow {
  id: string
  user_id: string
  folder_id: string
  title: string
  level_count: number
  bytes: number
  created_at: number
  updated_at: number
}

export interface CloudFolderDocRow {
  folder_id: string
  doc_id: string
  kind: string
  payload: string
  bytes: number
}

export interface HubItemRow {
  group_id: string | null
  id: string
  scope: string
  item_kind: string
  root_doc_id: string
  title: string
  level_count: number
  bytes: number
  submitter_id: string | null
  submitter_name: string
  submitter_note: string | null
  want_featured: number
  status: string
  featured: number
  reject_reason: string | null
  reviewed_by: string | null
  reviewed_at: number | null
  published_at: number | null
  downloads: number
  created_at: number
  updated_at: number
}

export interface HubItemDocRow {
  item_id: string
  doc_id: string
  kind: string
  payload: string
  bytes: number
}

export interface GroupRow {
  id: string
  name: string
  join_code: string
  join_pw_hash: string | null
  intro: string | null
  owner_id: string
  status: string
  created_at: number
  updated_at: number
}

export interface GroupMemberRow {
  group_id: string
  user_id: string
  role: string
  joined_at: number
}

/** LIKE '%x%' → 大小写不敏感子串匹配（SQLite LIKE 的 ASCII 不敏感语义近似） */
function likeMatch(value: string, pattern: string): boolean {
  return value.toLowerCase().includes(pattern.replace(/^%/, '').replace(/%$/, '').toLowerCase())
}

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

/**
 * 最小 D1 fake（docs/31 §9 测试策略）：按「SQL 语句 → 内存表操作」映射实现
 * prepare/bind/first/all/run 子集，node 环境零依赖跑通 handler 业务逻辑
 * （参数绑定、限流窗口、会话过期/续期、NOCASE 唯一等）。
 *
 * 已知取舍：SQL 语法/索引正确性由 wrangler dev 实测兜底；worker 侧 SQL 变更时
 * 必须同步在此登记——未识别语句直接 throw，测试会大声失败，不会静默放空。
 */
export class D1Fake implements D1Database {
  users: Row[] = []
  sessions: SessionRow[] = []
  login_attempts: LoginAttemptRow[] = []
  cloud_levels: CloudLevelRow[] = []
  cloud_folders: CloudFolderRow[] = []
  cloud_folder_docs: CloudFolderDocRow[] = []
  hub_items: HubItemRow[] = []
  hub_item_docs: HubItemDocRow[] = []
  groups: GroupRow[] = []
  group_members: GroupMemberRow[] = []
  progress: ProgressRow[] = []
  audit_log: AuditRow[] = []
  /** 已执行的规范化 SQL（断言/排查用） */
  executedSql: string[] = []

  prepare(sql: string): D1PreparedStatement {
    let bound: unknown[] = []
    const statement: D1PreparedStatement = {
      bind: (...values: unknown[]) => {
        bound = values
        return statement
      },
      first: async <T>() => ((await this.exec(norm(sql), bound)).results[0] as T | undefined) ?? null,
      all: async <T>() => ({ results: (await this.exec(norm(sql), bound)).results as T[], success: true }),
      run: async () => {
        const { changes } = await this.exec(norm(sql), bound)
        return { success: true, meta: { changes } }
      },
    }
    return statement
  }

  async batch(statements: D1PreparedStatement[]): Promise<Array<{ results?: unknown[]; success: boolean }>> {
    const out: Array<{ results?: unknown[]; success: boolean }> = []
    for (const statement of statements) {
      out.push({ results: (await statement.all()).results, success: true })
    }
    return out
  }

  /** 便捷播种：直接构造用户行（绕过 SQL 校验路径） */
  seedUser(row: Row): void {
    this.users.push(row)
  }

  /** 列投影：按逗号分隔的裸列名从行中取字段（hub 列表语句共用，不支持表前缀/别名） */
  private pick(row: Row, cols: string): Row {
    const out: Row = {}
    for (const c of cols.split(',').map((s) => s.trim())) {
      if (c in row) out[c] = row[c]
    }
    return out
  }

  private async exec(sql: string, p: unknown[]): Promise<{ results: Row[]; changes: number }> {
    this.executedSql.push(sql)

    // ---- users ----
    let m = /^SELECT .+ FROM users WHERE id = \?$/.exec(sql)
    if (m) return { results: this.users.filter((r) => r.id === p[0]), changes: 0 }

    m = /^SELECT .+ FROM users WHERE nickname = \?$/.exec(sql)
    if (m) {
      // UNIQUE COLLATE NOCASE 语义：等值比较大小写不敏感
      const target = String(p[0]).toLowerCase()
      return { results: this.users.filter((r) => String(r.nickname).toLowerCase() === target), changes: 0 }
    }

    m = /^INSERT INTO users \(.+\) VALUES \((\?, ){6}\?\)$/.exec(sql)
    if (m) {
      const target = String(p[1]).toLowerCase()
      if (this.users.some((r) => String(r.nickname).toLowerCase() === target)) {
        throw new Error('UNIQUE constraint failed: users.nickname')
      }
      this.users.push({ id: p[0], nickname: p[1], pw_hash: p[2], role: p[3], status: p[4], created_at: p[5], updated_at: p[6] })
      return { results: [], changes: 1 }
    }

    m = /^UPDATE users SET nickname = \?, updated_at = \? WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.users.find((r) => r.id === p[2])
      if (!row) return { results: [], changes: 0 }
      row.nickname = p[0]
      row.updated_at = p[1]
      return { results: [], changes: 1 }
    }

    m = /^UPDATE users SET pw_hash = \?, updated_at = \? WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.users.find((r) => r.id === p[2])
      if (!row) return { results: [], changes: 0 }
      row.pw_hash = p[0]
      row.updated_at = p[1]
      return { results: [], changes: 1 }
    }

    // ---- sessions ----
    m = /^INSERT INTO sessions \(.+\) VALUES \((\?, ){4}\?\)$/.exec(sql)
    if (m) {
      this.sessions.push({ id: String(p[0]), user_id: String(p[1]), created_at: Number(p[2]), last_seen_at: Number(p[3]), expires_at: Number(p[4]) })
      return { results: [], changes: 1 }
    }

    m = /^SELECT .+ FROM sessions WHERE id = \?$/.exec(sql)
    if (m) return { results: this.sessions.filter((r) => r.id === p[0]) as unknown as Row[], changes: 0 }

    m = /^UPDATE sessions SET last_seen_at = \?, expires_at = \? WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.sessions.find((r) => r.id === p[2])
      if (!row) return { results: [], changes: 0 }
      row.last_seen_at = Number(p[0])
      row.expires_at = Number(p[1])
      return { results: [], changes: 1 }
    }

    m = /^DELETE FROM sessions WHERE id = \?$/.exec(sql)
    if (m) {
      const before = this.sessions.length
      this.sessions = this.sessions.filter((r) => r.id !== p[0])
      return { results: [], changes: before - this.sessions.length }
    }

    m = /^DELETE FROM sessions WHERE user_id = \? AND id != \?$/.exec(sql)
    if (m) {
      const before = this.sessions.length
      this.sessions = this.sessions.filter((r) => !(r.user_id === p[0] && r.id !== p[1]))
      return { results: [], changes: before - this.sessions.length }
    }

    m = /^DELETE FROM sessions WHERE expires_at < \?$/.exec(sql)
    if (m) {
      const before = this.sessions.length
      this.sessions = this.sessions.filter((r) => r.expires_at >= Number(p[0]))
      return { results: [], changes: before - this.sessions.length }
    }

    // ---- login_attempts ----
    m = /^SELECT .+ FROM login_attempts WHERE key = \?$/.exec(sql)
    if (m) return { results: this.login_attempts.filter((r) => r.key === p[0]) as unknown as Row[], changes: 0 }

    m = /^UPDATE login_attempts SET fail_count = \?, window_start = \?, last_at = \? WHERE key = \?$/.exec(sql)
    if (m) {
      const row = this.login_attempts.find((r) => r.key === p[3])
      if (!row) return { results: [], changes: 0 }
      row.fail_count = Number(p[0])
      row.window_start = Number(p[1])
      row.last_at = Number(p[2])
      return { results: [], changes: 1 }
    }

    m = /^INSERT INTO login_attempts \(.+\) VALUES \((\?, ){3}\?\)$/.exec(sql)
    if (m) {
      if (this.login_attempts.some((r) => r.key === p[0])) {
        throw new Error('UNIQUE constraint failed: login_attempts.key')
      }
      this.login_attempts.push({ key: String(p[0]), fail_count: Number(p[1]), window_start: Number(p[2]), last_at: Number(p[3]) })
      return { results: [], changes: 1 }
    }

    m = /^DELETE FROM login_attempts WHERE key = \?$/.exec(sql)
    if (m) {
      const before = this.login_attempts.length
      this.login_attempts = this.login_attempts.filter((r) => r.key !== p[0])
      return { results: [], changes: before - this.login_attempts.length }
    }

    m = /^DELETE FROM login_attempts WHERE window_start < \?$/.exec(sql)
    if (m) {
      const before = this.login_attempts.length
      this.login_attempts = this.login_attempts.filter((r) => r.window_start >= Number(p[0]))
      return { results: [], changes: before - this.login_attempts.length }
    }

    // ---- cloud_levels ----
    m = /^SELECT id, level_id, title, bytes, schema_version, created_at, updated_at FROM cloud_levels WHERE user_id = \? ORDER BY updated_at DESC$/.exec(sql)
    if (m) {
      const rows = this.cloud_levels
        .filter((r) => r.user_id === p[0])
        .slice()
        .sort((a, b) => b.updated_at - a.updated_at)
      return { results: rows as unknown as Row[], changes: 0 }
    }

    m = /^SELECT id FROM cloud_levels WHERE user_id = \? AND level_id = \?$/.exec(sql)
    if (m) {
      const row = this.cloud_levels.find((r) => r.user_id === p[0] && r.level_id === p[1])
      return { results: row ? [row as unknown as Row] : [], changes: 0 }
    }

    m = /^SELECT COUNT\(\*\) AS n FROM cloud_levels WHERE user_id = \?$/.exec(sql)
    if (m) {
      return { results: [{ n: this.cloud_levels.filter((r) => r.user_id === p[0]).length }], changes: 0 }
    }

    m = /^INSERT INTO cloud_levels \(.+\) VALUES \((\?, ){8}\?\)$/.exec(sql)
    if (m) {
      if (this.cloud_levels.some((r) => r.id === p[0])) {
        throw new Error('UNIQUE constraint failed: cloud_levels.id')
      }
      if (this.cloud_levels.some((r) => r.user_id === p[1] && r.level_id === p[2])) {
        throw new Error('UNIQUE constraint failed: cloud_levels.user_id, cloud_levels.level_id')
      }
      this.cloud_levels.push({
        id: String(p[0]),
        user_id: String(p[1]),
        level_id: String(p[2]),
        title: String(p[3]),
        payload: String(p[4]),
        bytes: Number(p[5]),
        schema_version: Number(p[6]),
        created_at: Number(p[7]),
        updated_at: Number(p[8]),
      })
      return { results: [], changes: 1 }
    }

    m = /^UPDATE cloud_levels SET title = \?, payload = \?, bytes = \?, schema_version = \?, updated_at = \? WHERE user_id = \? AND level_id = \?$/.exec(sql)
    if (m) {
      const row = this.cloud_levels.find((r) => r.user_id === p[5] && r.level_id === p[6])
      if (!row) return { results: [], changes: 0 }
      row.title = String(p[0])
      row.payload = String(p[1])
      row.bytes = Number(p[2])
      row.schema_version = Number(p[3])
      row.updated_at = Number(p[4])
      return { results: [], changes: 1 }
    }

    m = /^SELECT .+ FROM cloud_levels WHERE id = \? AND user_id = \?$/.exec(sql)
    if (m) {
      const row = this.cloud_levels.find((r) => r.id === p[0] && r.user_id === p[1])
      return { results: row ? [row as unknown as Row] : [], changes: 0 }
    }

    m = /^UPDATE cloud_levels SET title = \?, payload = \?, bytes = \?, schema_version = \?, updated_at = \? WHERE id = \? AND user_id = \?$/.exec(sql)
    if (m) {
      const row = this.cloud_levels.find((r) => r.id === p[5] && r.user_id === p[6])
      if (!row) return { results: [], changes: 0 }
      row.title = String(p[0])
      row.payload = String(p[1])
      row.bytes = Number(p[2])
      row.schema_version = Number(p[3])
      row.updated_at = Number(p[4])
      return { results: [], changes: 1 }
    }

    m = /^DELETE FROM cloud_levels WHERE id = \? AND user_id = \?$/.exec(sql)
    if (m) {
      const before = this.cloud_levels.length
      this.cloud_levels = this.cloud_levels.filter((r) => !(r.id === p[0] && r.user_id === p[1]))
      return { results: [], changes: before - this.cloud_levels.length }
    }

    // ---- cloud_folders（docs/39 H2）----
    m = /^SELECT COALESCE\(SUM\(level_count\), 0\) AS n FROM cloud_folders WHERE user_id = \?$/.exec(sql)
    if (m) {
      const n = this.cloud_folders.filter((r) => r.user_id === p[0]).reduce((acc, r) => acc + Number(r.level_count), 0)
      return { results: [{ n }], changes: 0 }
    }

    m = /^SELECT id, folder_id, title, level_count, bytes, created_at, updated_at FROM cloud_folders WHERE user_id = \? ORDER BY updated_at DESC$/.exec(sql)
    if (m) {
      const rows = this.cloud_folders
        .filter((r) => r.user_id === p[0])
        .slice()
        .sort((a, b) => b.updated_at - a.updated_at)
      return { results: rows as unknown as Row[], changes: 0 }
    }

    m = /^SELECT id, folder_id, title, level_count, bytes, created_at, updated_at FROM cloud_folders WHERE id = \? AND user_id = \?$/.exec(sql)
    if (m) {
      const row = this.cloud_folders.find((r) => r.id === p[0] && r.user_id === p[1])
      return { results: row ? [row as unknown as Row] : [], changes: 0 }
    }

    m = /^SELECT id, level_count FROM cloud_folders WHERE user_id = \? AND folder_id = \?$/.exec(sql)
    if (m) {
      const row = this.cloud_folders.find((r) => r.user_id === p[0] && r.folder_id === p[1])
      return { results: row ? [row as unknown as Row] : [], changes: 0 }
    }

    m = /^INSERT INTO cloud_folders \(.+\) VALUES \((\?, ){7}\?\)$/.exec(sql)
    if (m) {
      if (this.cloud_folders.some((r) => r.id === p[0])) {
        throw new Error('UNIQUE constraint failed: cloud_folders.id')
      }
      if (this.cloud_folders.some((r) => r.user_id === p[1] && r.folder_id === p[2])) {
        throw new Error('UNIQUE constraint failed: cloud_folders.user_id, cloud_folders.folder_id')
      }
      this.cloud_folders.push({
        id: String(p[0]),
        user_id: String(p[1]),
        folder_id: String(p[2]),
        title: String(p[3]),
        level_count: Number(p[4]),
        bytes: Number(p[5]),
        created_at: Number(p[6]),
        updated_at: Number(p[7]),
      })
      return { results: [], changes: 1 }
    }

    m = /^UPDATE cloud_folders SET title = \?, level_count = \?, bytes = \?, updated_at = \? WHERE id = \? AND user_id = \?$/.exec(sql)
    if (m) {
      const row = this.cloud_folders.find((r) => r.id === p[4] && r.user_id === p[5])
      if (!row) return { results: [], changes: 0 }
      row.title = String(p[0])
      row.level_count = Number(p[1])
      row.bytes = Number(p[2])
      row.updated_at = Number(p[3])
      return { results: [], changes: 1 }
    }

    m = /^DELETE FROM cloud_folders WHERE id = \? AND user_id = \?$/.exec(sql)
    if (m) {
      const before = this.cloud_folders.length
      this.cloud_folders = this.cloud_folders.filter((r) => !(r.id === p[0] && r.user_id === p[1]))
      return { results: [], changes: before - this.cloud_folders.length }
    }

    // ---- cloud_folder_docs（docs/39 H2）----
    m = /^SELECT doc_id, kind, payload, bytes FROM cloud_folder_docs WHERE folder_id = \? ORDER BY doc_id$/.exec(sql)
    if (m) {
      const rows = this.cloud_folder_docs
        .filter((r) => r.folder_id === p[0])
        .slice()
        .sort((a, b) => (a.doc_id < b.doc_id ? -1 : 1))
      return { results: rows as unknown as Row[], changes: 0 }
    }

    m = /^DELETE FROM cloud_folder_docs WHERE folder_id = \?$/.exec(sql)
    if (m) {
      const before = this.cloud_folder_docs.length
      this.cloud_folder_docs = this.cloud_folder_docs.filter((r) => r.folder_id !== p[0])
      return { results: [], changes: before - this.cloud_folder_docs.length }
    }

    m = /^INSERT INTO cloud_folder_docs \(.+\) VALUES \((\?, ){4}\?\)$/.exec(sql)
    if (m) {
      if (this.cloud_folder_docs.some((r) => r.folder_id === p[0] && r.doc_id === p[1])) {
        throw new Error('UNIQUE constraint failed: cloud_folder_docs.folder_id, cloud_folder_docs.doc_id')
      }
      this.cloud_folder_docs.push({
        folder_id: String(p[0]),
        doc_id: String(p[1]),
        kind: String(p[2]),
        payload: String(p[3]),
        bytes: Number(p[4]),
      })
      return { results: [], changes: 1 }
    }

    // ---- hub_items（docs/39 H3）----
    m = /^INSERT INTO hub_items \(.+\) VALUES \((\?, ){20}\?\)$/.exec(sql)
    if (m) {
      if (this.hub_items.some((r) => r.id === p[0])) {
        throw new Error('UNIQUE constraint failed: hub_items.id')
      }
      if ((String(p[1]) === 'public' || String(p[1]) === 'official') && this.hub_items.some((r) => r.scope === p[1] && r.root_doc_id === p[3])) {
        // 部分唯一索引 idx_hub_root_public 近似
        throw new Error('UNIQUE constraint failed: hub_items.root_doc_id')
      }
      if (String(p[1]) === 'group' && this.hub_items.some((r) => r.scope === 'group' && r.group_id === String(p[20]) && r.root_doc_id === String(p[3]))) {
        // UNIQUE(group_id, root_doc_id) 近似
        throw new Error('UNIQUE constraint failed: hub_items.group_id, hub_items.root_doc_id')
      }
      this.hub_items.push({
        group_id: p[20] === null ? null : String(p[20]),
        id: String(p[0]),
        scope: String(p[1]),
        item_kind: String(p[2]),
        root_doc_id: String(p[3]),
        title: String(p[4]),
        level_count: Number(p[5]),
        bytes: Number(p[6]),
        submitter_id: p[7] === null ? null : String(p[7]),
        submitter_name: String(p[8]),
        submitter_note: p[9] === null ? null : String(p[9]),
        want_featured: Number(p[10]),
        status: String(p[11]),
        featured: Number(p[12]),
        reject_reason: p[13] === null ? null : String(p[13]),
        reviewed_by: p[14] === null ? null : String(p[14]),
        reviewed_at: p[15] === null ? null : Number(p[15]),
        published_at: p[16] === null ? null : Number(p[16]),
        downloads: Number(p[17]),
        created_at: Number(p[18]),
        updated_at: Number(p[19]),
      })
      return { results: [], changes: 1 }
    }

    m = /^SELECT id, status, submitter_id FROM hub_items WHERE scope = 'public' AND root_doc_id = \?$/.exec(sql)
    if (m) {
      const row = this.hub_items.find((r) => r.scope === 'public' && r.root_doc_id === p[0])
      return { results: row ? [row as unknown as Row] : [], changes: 0 }
    }

    m = /^SELECT COUNT\(\*\) AS n FROM hub_items WHERE submitter_id = \? AND status = 'pending'$/.exec(sql)
    if (m) {
      return { results: [{ n: this.hub_items.filter((r) => r.submitter_id === p[0] && r.status === 'pending').length }], changes: 0 }
    }

    m = /^SELECT id, submitter_id, status, group_id FROM hub_items WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.hub_items.find((r) => r.id === p[0])
      return { results: row ? [row as unknown as Row] : [], changes: 0 }
    }

    m = /^UPDATE hub_items SET featured = \?, updated_at = \? WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.hub_items.find((r) => r.id === p[2])
      if (!row) return { results: [], changes: 0 }
      row.featured = Number(p[0])
      row.updated_at = Number(p[1])
      return { results: [], changes: 1 }
    }

    m = /^SELECT COUNT\(\*\) AS n FROM hub_items WHERE scope = 'official'$/.exec(sql)
    if (m) {
      return { results: [{ n: this.hub_items.filter((r) => r.scope === 'official').length }], changes: 0 }
    }

    m = /^SELECT (.+) FROM hub_items WHERE scope = 'official' AND root_doc_id = \?$/.exec(sql)
    if (m) {
      const row = this.hub_items.find((r) => r.scope === 'official' && r.root_doc_id === p[0])
      return { results: row ? [this.pick(row as unknown as Row, m![1])] : [], changes: 0 }
    }

    m = /^SELECT id, scope FROM hub_items WHERE root_doc_id = \? AND scope IN \('public', 'official'\)$/.exec(sql)
    if (m) {
      const row = this.hub_items.find((r) => (r.scope === 'public' || r.scope === 'official') && r.root_doc_id === p[0])
      return { results: row ? [{ id: row.id, scope: row.scope }] : [], changes: 0 }
    }

    m = /^SELECT (.+) FROM hub_items WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.hub_items.find((r) => r.id === p[0])
      return { results: row ? [this.pick(row as unknown as Row, m![1])] : [], changes: 0 }
    }

    m = /^UPDATE hub_items SET downloads = downloads \+ 1 WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.hub_items.find((r) => r.id === p[0])
      if (!row) return { results: [], changes: 0 }
      row.downloads += 1
      return { results: [], changes: 1 }
    }

    m = /^UPDATE hub_items SET status = 'published', featured = \?, reviewed_by = \?, reviewed_at = \?, published_at = \?, updated_at = \? WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.hub_items.find((r) => r.id === p[5])
      if (!row) return { results: [], changes: 0 }
      row.status = 'published'
      row.featured = Number(p[0])
      row.reviewed_by = p[1] === null ? null : String(p[1])
      row.reviewed_at = Number(p[2])
      row.published_at = Number(p[3])
      row.updated_at = Number(p[4])
      return { results: [], changes: 1 }
    }

    m = /^UPDATE hub_items SET status = 'rejected', reject_reason = \?, reviewed_by = \?, reviewed_at = \?, updated_at = \? WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.hub_items.find((r) => r.id === p[4])
      if (!row) return { results: [], changes: 0 }
      row.status = 'rejected'
      row.reject_reason = p[0] === null ? null : String(p[0])
      row.reviewed_by = p[1] === null ? null : String(p[1])
      row.reviewed_at = Number(p[2])
      row.updated_at = Number(p[3])
      return { results: [], changes: 1 }
    }

    m = /^DELETE FROM hub_items WHERE id = \?$/.exec(sql)
    if (m) {
      const before = this.hub_items.length
      this.hub_items = this.hub_items.filter((r) => r.id !== p[0])
      return { results: [], changes: before - this.hub_items.length }
    }

    // hub_items 列表：公共（published，可选 featured/LIKE）
    {
      const listRe = /^SELECT (.+) FROM hub_items WHERE scope = \? AND status = 'published'( AND featured = 1)?( AND title LIKE \?)? ORDER BY published_at DESC LIMIT \? OFFSET \?$/.exec(sql)
      if (listRe) {
        let rows = this.hub_items.filter((r) => r.scope === p[0] && r.status === 'published')
        if (listRe[2]) rows = rows.filter((r) => r.featured === 1)
        if (listRe[3]) rows = rows.filter((r) => likeMatch(r.title, String(p[1])))
        const limitIdx = listRe[2] && listRe[3] ? 3 : listRe[2] || listRe[3] ? 2 : 1
        rows = rows
          .slice()
          .sort((a, b) => Number(b.published_at ?? 0) - Number(a.published_at ?? 0))
          .slice(Number(p[limitIdx + 1]), Number(p[limitIdx + 1]) + Number(p[limitIdx]))
        return { results: rows.map((r) => this.pick(r as unknown as Row, listRe[1])) , changes: 0 }
      }
      const countRe = /^SELECT COUNT\(\*\) AS n FROM hub_items WHERE scope = \? AND status = 'published'( AND featured = 1)?( AND title LIKE \?)?$/.exec(sql)
      if (countRe) {
        let rows = this.hub_items.filter((r) => r.scope === p[0] && r.status === 'published')
        if (countRe[2]) rows = rows.filter((r) => r.featured === 1)
        if (countRe[3]) rows = rows.filter((r) => likeMatch(r.title, String(p[1])))
        return { results: [{ n: rows.length }], changes: 0 }
      }
    }

    m = /^SELECT (.+) FROM hub_items WHERE submitter_id = \? ORDER BY updated_at DESC$/.exec(sql)
    if (m) {
      const rows = this.hub_items
        .filter((r) => r.submitter_id === p[0])
        .slice()
        .sort((a, b) => b.updated_at - a.updated_at)
      return { results: rows.map((r) => this.pick(r as unknown as Row, m![1])), changes: 0 }
    }

    // hub_items 管理队列：按 status（可选 LIKE）
    {
      const adminRe = /^SELECT (.+) FROM hub_items WHERE status = \?( AND title LIKE \?)? ORDER BY updated_at DESC LIMIT \? OFFSET \?$/.exec(sql)
      if (adminRe) {
        let rows = this.hub_items.filter((r) => r.status === p[0])
        if (adminRe[2]) rows = rows.filter((r) => likeMatch(r.title, String(p[1])))
        const limitIdx = adminRe[2] ? 2 : 1
        rows = rows
          .slice()
          .sort((a, b) => b.updated_at - a.updated_at)
          .slice(Number(p[limitIdx + 1]), Number(p[limitIdx + 1]) + Number(p[limitIdx]))
        return { results: rows.map((r) => this.pick(r as unknown as Row, adminRe[1])), changes: 0 }
      }
      const adminCountRe = /^SELECT COUNT\(\*\) AS n FROM hub_items WHERE status = \?( AND title LIKE \?)?$/.exec(sql)
      if (adminCountRe) {
        let rows = this.hub_items.filter((r) => r.status === p[0])
        if (adminCountRe[1]) rows = rows.filter((r) => likeMatch(r.title, String(p[1])))
        return { results: [{ n: rows.length }], changes: 0 }
      }
    }

    // ---- hub_item_docs（docs/39 H3）----
    m = /^SELECT doc_id, kind, payload, bytes FROM hub_item_docs WHERE item_id = \? ORDER BY doc_id$/.exec(sql)
    if (m) {
      const rows = this.hub_item_docs
        .filter((r) => r.item_id === p[0])
        .slice()
        .sort((a, b) => (a.doc_id < b.doc_id ? -1 : 1))
      return { results: rows as unknown as Row[], changes: 0 }
    }

    m = /^DELETE FROM hub_item_docs WHERE item_id = \?$/.exec(sql)
    if (m) {
      const before = this.hub_item_docs.length
      this.hub_item_docs = this.hub_item_docs.filter((r) => r.item_id !== p[0])
      return { results: [], changes: before - this.hub_item_docs.length }
    }

    m = /^INSERT INTO hub_item_docs \(.+\) VALUES \((\?, ){4}\?\)$/.exec(sql)
    if (m) {
      if (this.hub_item_docs.some((r) => r.item_id === p[0] && r.doc_id === p[1])) {
        throw new Error('UNIQUE constraint failed: hub_item_docs.item_id, hub_item_docs.doc_id')
      }
      this.hub_item_docs.push({
        item_id: String(p[0]),
        doc_id: String(p[1]),
        kind: String(p[2]),
        payload: String(p[3]),
        bytes: Number(p[4]),
      })
      return { results: [], changes: 1 }
    }

    // ---- hub 群组条目（docs/39 H5）----
    m = /^SELECT id FROM hub_items WHERE scope = 'group' AND group_id = \? AND root_doc_id = \?$/.exec(sql)
    if (m) {
      const row = this.hub_items.find((r) => r.scope === 'group' && r.group_id === p[0] && r.root_doc_id === p[1])
      return { results: row ? [{ id: row.id }] : [], changes: 0 }
    }

    m = /^SELECT id FROM hub_items WHERE group_id = \?$/.exec(sql)
    if (m) {
      const rows = this.hub_items.filter((r) => r.group_id === p[0]).map((r) => ({ id: r.id }))
      return { results: rows, changes: 0 }
    }

    m = /^SELECT COALESCE\(SUM\(level_count\), 0\) AS n FROM hub_items WHERE group_id = \?$/.exec(sql)
    if (m) {
      const n = this.hub_items.filter((r) => r.group_id === p[0]).reduce((acc, r) => acc + Number(r.level_count), 0)
      return { results: [{ n }], changes: 0 }
    }

    m = /^SELECT COALESCE\(SUM\(level_count\), 0\) AS n FROM hub_items WHERE group_id = \? AND submitter_id = \?$/.exec(sql)
    if (m) {
      const n = this.hub_items.filter((r) => r.group_id === p[0] && r.submitter_id === p[1]).reduce((acc, r) => acc + Number(r.level_count), 0)
      return { results: [{ n }], changes: 0 }
    }

    {
      const groupListRe = /^SELECT (.+) FROM hub_items WHERE group_id = \? ORDER BY updated_at DESC$/.exec(sql)
      if (groupListRe) {
        const rows = this.hub_items
          .filter((r) => r.group_id === p[0])
          .slice()
          .sort((a, b) => b.updated_at - a.updated_at)
        return { results: rows.map((r) => this.pick(r as unknown as Row, groupListRe[1])), changes: 0 }
      }
    }

    // ---- groups / group_members（docs/39 H5）----
    m = /^INSERT INTO groups \(.+\) VALUES \((\?, ){8}\?\)$/.exec(sql)
    if (m) {
      if (this.groups.some((r) => r.id === p[0])) {
        throw new Error('UNIQUE constraint failed: groups.id')
      }
      if (this.groups.some((r) => r.join_code.toLowerCase() === String(p[2]).toLowerCase())) {
        // UNIQUE COLLATE NOCASE 近似
        throw new Error('UNIQUE constraint failed: groups.join_code')
      }
      this.groups.push({
        id: String(p[0]),
        name: String(p[1]),
        join_code: String(p[2]),
        join_pw_hash: p[3] === null ? null : String(p[3]),
        intro: p[4] === null ? null : String(p[4]),
        owner_id: String(p[5]),
        status: String(p[6]),
        created_at: Number(p[7]),
        updated_at: Number(p[8]),
      })
      return { results: [], changes: 1 }
    }

    m = /^SELECT id, name, join_code, join_pw_hash, intro, owner_id, status, created_at, updated_at FROM groups WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.groups.find((r) => r.id === p[0])
      return { results: row ? [row as unknown as Row] : [], changes: 0 }
    }

    m = /^SELECT id FROM groups WHERE join_code = \?$/.exec(sql)
    if (m) {
      const target = String(p[0]).toLowerCase()
      const row = this.groups.find((r) => r.join_code.toLowerCase() === target)
      return { results: row ? [{ id: row.id }] : [], changes: 0 }
    }

    m = /^SELECT (.+) FROM groups WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.groups.find((r) => r.id === p[0])
      return { results: row ? [this.pick(row as unknown as Row, m![1])] : [], changes: 0 }
    }
    if (m) {
      const target = String(p[0]).toLowerCase()
      const row = this.groups.find((r) => r.join_code.toLowerCase() === target)
      return { results: row ? [{ id: row.id }] : [], changes: 0 }
    }

    m = /^SELECT COUNT\(\*\) AS n FROM groups WHERE owner_id = \?$/.exec(sql)
    if (m) {
      return { results: [{ n: this.groups.filter((r) => r.owner_id === p[0]).length }], changes: 0 }
    }

    m = /^UPDATE groups SET name = \?, join_code = \?, join_pw_hash = \?, intro = \?, updated_at = \? WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.groups.find((r) => r.id === p[5])
      if (!row) return { results: [], changes: 0 }
      if (this.groups.some((r) => r.id !== row.id && r.join_code.toLowerCase() === String(p[1]).toLowerCase())) {
        throw new Error('UNIQUE constraint failed: groups.join_code')
      }
      row.name = String(p[0])
      row.join_code = String(p[1])
      row.join_pw_hash = p[2] === null ? null : String(p[2])
      row.intro = p[3] === null ? null : String(p[3])
      row.updated_at = Number(p[4])
      return { results: [], changes: 1 }
    }

    m = /^UPDATE groups SET status = \?, updated_at = \? WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.groups.find((r) => r.id === p[2])
      if (!row) return { results: [], changes: 0 }
      row.status = String(p[0])
      row.updated_at = Number(p[1])
      return { results: [], changes: 1 }
    }

    m = /^DELETE FROM groups WHERE id = \?$/.exec(sql)
    if (m) {
      const before = this.groups.length
      this.groups = this.groups.filter((r) => r.id !== p[0])
      // FK CASCADE 近似：成员与群库条目一并清除
      this.group_members = this.group_members.filter((r) => r.group_id !== p[0])
      this.hub_items = this.hub_items.filter((r) => r.group_id !== p[0])
      this.hub_item_docs = this.hub_item_docs.filter((d) => this.hub_items.some((h) => h.id === d.item_id))
      return { results: [], changes: before - this.groups.length }
    }

    m = /^INSERT INTO group_members \(.+\) VALUES \((\?, ){3}\?\)$/.exec(sql)
    if (m) {
      if (this.group_members.some((r) => r.group_id === p[0] && r.user_id === p[1])) {
        throw new Error('UNIQUE constraint failed: group_members.group_id, group_members.user_id')
      }
      this.group_members.push({
        group_id: String(p[0]),
        user_id: String(p[1]),
        role: String(p[2]),
        joined_at: Number(p[3]),
      })
      return { results: [], changes: 1 }
    }

    m = /^SELECT group_id, user_id, role FROM group_members WHERE group_id = \? AND user_id = \?$/.exec(sql)
    if (m) {
      const row = this.group_members.find((r) => r.group_id === p[0] && r.user_id === p[1])
      return { results: row ? [row as unknown as Row] : [], changes: 0 }
    }

    m = /^SELECT group_id, user_id, role, joined_at FROM group_members WHERE group_id = \? ORDER BY joined_at$/.exec(sql)
    if (m) {
      const rows = this.group_members
        .filter((r) => r.group_id === p[0])
        .slice()
        .sort((a, b) => a.joined_at - b.joined_at)
      return { results: rows as unknown as Row[], changes: 0 }
    }

    m = /^SELECT group_id, role FROM group_members WHERE user_id = \?$/.exec(sql)
    if (m) {
      const rows = this.group_members.filter((r) => r.user_id === p[0])
      return { results: rows as unknown as Row[], changes: 0 }
    }

    m = /^UPDATE group_members SET role = \? WHERE group_id = \? AND user_id = \?$/.exec(sql)
    if (m) {
      const row = this.group_members.find((r) => r.group_id === p[1] && r.user_id === p[2])
      if (!row) return { results: [], changes: 0 }
      row.role = String(p[0])
      return { results: [], changes: 1 }
    }

    m = /^DELETE FROM group_members WHERE group_id = \?$/.exec(sql)
    if (m) {
      const before = this.group_members.length
      this.group_members = this.group_members.filter((r) => r.group_id !== p[0])
      return { results: [], changes: before - this.group_members.length }
    }

    m = /^DELETE FROM group_members WHERE group_id = \? AND user_id = \?$/.exec(sql)
    if (m) {
      const before = this.group_members.length
      this.group_members = this.group_members.filter((r) => !(r.group_id === p[0] && r.user_id === p[1]))
      return { results: [], changes: before - this.group_members.length }
    }

    // ---- admin：群组列表 ----
    {
      const adminGroupRe = /^SELECT (.+) FROM groups WHERE name LIKE \? ORDER BY created_at DESC LIMIT \? OFFSET \?$/.exec(sql)
      if (adminGroupRe) {
        const rows = this.groups
          .filter((r) => likeMatch(r.name, String(p[0])))
          .slice()
          .sort((a, b) => b.created_at - a.created_at)
          .slice(Number(p[2]), Number(p[2]) + Number(p[1]))
        return { results: rows.map((r) => this.pick(r as unknown as Row, adminGroupRe[1])), changes: 0 }
      }
      const adminGroupCountRe = /^SELECT COUNT\(\*\) AS n FROM groups WHERE name LIKE \?\)?$/.exec(sql)
      if (adminGroupCountRe) {
        return { results: [{ n: this.groups.filter((r) => likeMatch(r.name, String(p[0]))).length }], changes: 0 }
      }
    }

    // ---- progress ----
    m = /^SELECT level_id, best_score, passed, attempts, updated_at FROM progress WHERE user_id = \?$/.exec(sql)
    if (m) {
      return { results: this.progress.filter((r) => r.user_id === p[0]) as unknown as Row[], changes: 0 }
    }

    m = /^INSERT INTO progress \(user_id, level_id, best_score, passed, attempts, updated_at\) VALUES \(\?, \?, \?, \?, \?, \?\) ON CONFLICT\(user_id, level_id\) DO UPDATE SET best_score = MAX\(excluded\.best_score, progress\.best_score\), passed = MAX\(excluded\.passed, progress\.passed\), attempts = MAX\(excluded\.attempts, progress\.attempts\), updated_at = MAX\(excluded\.updated_at, progress\.updated_at\)$/.exec(
      sql,
    )
    if (m) {
      const incoming: ProgressRow = {
        user_id: String(p[0]),
        level_id: String(p[1]),
        best_score: Number(p[2]),
        passed: Number(p[3]),
        attempts: Number(p[4]),
        updated_at: Number(p[5]),
      }
      const existing = this.progress.find((r) => r.user_id === incoming.user_id && r.level_id === incoming.level_id)
      if (!existing) {
        this.progress.push(incoming)
      } else {
        existing.best_score = Math.max(existing.best_score, incoming.best_score)
        existing.passed = Math.max(existing.passed, incoming.passed)
        existing.attempts = Math.max(existing.attempts, incoming.attempts)
        existing.updated_at = Math.max(existing.updated_at, incoming.updated_at)
      }
      return { results: [], changes: 1 }
    }

    // ---- admin：统计 ----
    m = /^SELECT COUNT\(\*\) AS n FROM users$/.exec(sql)
    if (m) return { results: [{ n: this.users.length }], changes: 0 }
    m = /^SELECT COUNT\(\*\) AS n FROM cloud_levels$/.exec(sql)
    if (m) return { results: [{ n: this.cloud_levels.length }], changes: 0 }
    m = /^SELECT COUNT\(\*\) AS n FROM sessions WHERE expires_at > \?$/.exec(sql)
    if (m) return { results: [{ n: this.sessions.filter((r) => r.expires_at > Number(p[0])).length }], changes: 0 }

    // ---- admin：用户列表/修改/删除 ----
    m = /^SELECT id, nickname, role, status, created_at FROM users WHERE nickname LIKE \? ORDER BY created_at DESC LIMIT \? OFFSET \?$/.exec(sql)
    if (m) {
      const rows = this.users
        .filter((r) => likeMatch(String(r.nickname), String(p[0])))
        .slice()
        .sort((a, b) => Number(b.created_at) - Number(a.created_at))
        .slice(Number(p[2]), Number(p[2]) + Number(p[1]))
      return { results: rows as unknown as Row[], changes: 0 }
    }
    m = /^SELECT COUNT\(\*\) AS n FROM users WHERE nickname LIKE \?$/.exec(sql)
    if (m) return { results: [{ n: this.users.filter((r) => likeMatch(String(r.nickname), String(p[0]))).length }], changes: 0 }

    m = /^UPDATE users SET status = \?, updated_at = \? WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.users.find((r) => r.id === p[2])
      if (!row) return { results: [], changes: 0 }
      row.status = p[0]
      row.updated_at = Number(p[1])
      return { results: [], changes: 1 }
    }
    m = /^UPDATE users SET role = \?, updated_at = \? WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.users.find((r) => r.id === p[2])
      if (!row) return { results: [], changes: 0 }
      row.role = p[0]
      row.updated_at = Number(p[1])
      return { results: [], changes: 1 }
    }
    m = /^DELETE FROM sessions WHERE user_id = \?$/.exec(sql)
    if (m) {
      const before = this.sessions.length
      this.sessions = this.sessions.filter((r) => r.user_id !== p[0])
      return { results: [], changes: before - this.sessions.length }
    }
    m = /^DELETE FROM cloud_levels WHERE user_id = \?$/.exec(sql)
    if (m) {
      const before = this.cloud_levels.length
      this.cloud_levels = this.cloud_levels.filter((r) => r.user_id !== p[0])
      return { results: [], changes: before - this.cloud_levels.length }
    }
    m = /^DELETE FROM progress WHERE user_id = \?$/.exec(sql)
    if (m) {
      const before = this.progress.length
      this.progress = this.progress.filter((r) => r.user_id !== p[0])
      return { results: [], changes: before - this.progress.length }
    }
    m = /^DELETE FROM users WHERE id = \?$/.exec(sql)
    if (m) {
      const before = this.users.length
      this.users = this.users.filter((r) => r.id !== p[0])
      return { results: [], changes: before - this.users.length }
    }

    // ---- admin：关卡列表/删除 ----
    m = /^SELECT c\.id, c\.user_id, c\.level_id, c\.title, c\.bytes, c\.schema_version, c\.created_at, c\.updated_at, u\.nickname AS owner_nickname FROM cloud_levels c JOIN users u ON u\.id = c\.user_id WHERE c\.title LIKE \? ORDER BY c\.updated_at DESC LIMIT \? OFFSET \?$/.exec(sql)
    if (m) {
      const rows = this.cloud_levels
        .filter((r) => likeMatch(r.title, String(p[0])))
        .slice()
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(Number(p[2]), Number(p[2]) + Number(p[1]))
        .map((r) => ({ ...r, owner_nickname: String(this.users.find((u) => u.id === r.user_id)?.nickname ?? '') }))
      return { results: rows as unknown as Row[], changes: 0 }
    }
    m = /^SELECT COUNT\(\*\) AS n FROM cloud_levels c JOIN users u ON u\.id = c\.user_id WHERE c\.title LIKE \?$/.exec(sql)
    if (m) return { results: [{ n: this.cloud_levels.filter((r) => likeMatch(r.title, String(p[0]))).length }], changes: 0 }
    m = /^SELECT id, user_id, title FROM cloud_levels WHERE id = \?$/.exec(sql)
    if (m) {
      const row = this.cloud_levels.find((r) => r.id === p[0])
      return { results: row ? [row as unknown as Row] : [], changes: 0 }
    }
    m = /^DELETE FROM cloud_levels WHERE id = \?$/.exec(sql)
    if (m) {
      const before = this.cloud_levels.length
      this.cloud_levels = this.cloud_levels.filter((r) => r.id !== p[0])
      return { results: [], changes: before - this.cloud_levels.length }
    }

    // ---- admin：审计 ----
    m = /^INSERT INTO audit_log \(id, actor_id, action, target_type, target_id, detail, created_at\) VALUES \(\?, \?, \?, \?, \?, \?, \?\)$/.exec(sql)
    if (m) {
      this.audit_log.push({
        id: String(p[0]),
        actor_id: p[1] === null ? null : String(p[1]),
        action: String(p[2]),
        target_type: String(p[3]),
        target_id: String(p[4]),
        detail: p[5] === null ? null : String(p[5]),
        created_at: Number(p[6]),
      })
      return { results: [], changes: 1 }
    }
    m = /^SELECT a\.id, a\.actor_id, a\.action, a\.target_type, a\.target_id, a\.detail, a\.created_at, u\.nickname AS actor_nickname FROM audit_log a LEFT JOIN users u ON u\.id = a\.actor_id ORDER BY a\.created_at DESC LIMIT \? OFFSET \?$/.exec(sql)
    if (m) {
      const rows = this.audit_log
        .slice()
        .sort((a, b) => b.created_at - a.created_at)
        .slice(Number(p[1]), Number(p[1]) + Number(p[0]))
        .map((r) => ({ ...r, actor_nickname: String(this.users.find((u) => u.id === r.actor_id)?.nickname ?? '') }))
      return { results: rows as unknown as Row[], changes: 0 }
    }
    m = /^SELECT COUNT\(\*\) AS n FROM audit_log$/.exec(sql)
    if (m) return { results: [{ n: this.audit_log.length }], changes: 0 }

    throw new Error(`D1Fake 未支持的语句: ${sql}`)
  }
}
