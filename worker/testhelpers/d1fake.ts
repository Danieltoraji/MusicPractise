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

    throw new Error(`D1Fake 未支持的语句: ${sql}`)
  }
}
