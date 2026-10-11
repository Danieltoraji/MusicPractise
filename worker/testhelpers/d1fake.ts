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
