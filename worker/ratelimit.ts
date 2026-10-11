import type { D1Database, Env } from './types'

/**
 * 登录/注册限流（docs/31 §6.4 定稿）：D1 滑动窗口实现——与「handler 纯函数 +
 * D1 fake」测试策略兼容、零 wrangler 配置风险。Rate Limiting binding 作为
 * 远期可选优化，不进 B1。写放大在 50 DAU 下可忽略。
 *
 * 登录：只计失败，5 次失败/15 分钟/(IP哈希+昵称) 锁定至窗口结束；
 * 注册：按尝试计数（防通过注册接口探测昵称占用），10 次/小时/IP。
 */
export const LOGIN_MAX_FAILS = 5
export const LOGIN_WINDOW_MS = 15 * 60_000
export const REGISTER_MAX = 10
export const REGISTER_WINDOW_MS = 3_600_000
/** 云盘写操作（上传/覆盖/删除）：30 次/小时/用户（docs/31 §5.2） */
export const CLOUD_WRITE_MAX = 30
export const CLOUD_WINDOW_MS = 3_600_000

const encoder = new TextEncoder()

/** IP 哈希：SHA-256(ip + 盐) 截 8 字节 hex——不落原始 IP（隐私），盐防彩虹表反查 */
export async function ipHashOf(req: Request, env: Env): Promise<string> {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown'
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(`${ip}|${env.IP_HASH_SALT ?? ''}`))
  let hex = ''
  for (const b of new Uint8Array(bytes).slice(0, 8)) hex += b.toString(16).padStart(2, '0')
  return hex
}

const loginKey = (ipHash: string, nickname: string): string => `login:${ipHash}:${nickname}`
const registerKey = (ipHash: string): string => `register:${ipHash}`
const cloudKey = (userId: string): string => `cloud:${userId}`

interface AttemptRow {
  fail_count: number
  window_start: number
}

async function getAttempt(db: D1Database, key: string): Promise<AttemptRow | null> {
  const row = await db.prepare('SELECT fail_count, window_start FROM login_attempts WHERE key = ?').bind(key).first<AttemptRow>()
  return row ?? null
}

async function putAttempt(db: D1Database, key: string, failCount: number, windowStart: number, now: number): Promise<void> {
  const updated = await db
    .prepare('UPDATE login_attempts SET fail_count = ?, window_start = ?, last_at = ? WHERE key = ?')
    .bind(failCount, windowStart, now, key)
    .run()
  if ((updated.meta?.changes ?? 0) !== 0) return
  try {
    await db
      .prepare('INSERT INTO login_attempts (key, fail_count, window_start, last_at) VALUES (?, ?, ?, ?)')
      .bind(key, failCount, windowStart, now)
      .run()
  } catch {
    // 并发首写撞主键：极小概率，丢弃本次计数（后续写入走 UPDATE 路径）
  }
}

/** 登录是否被锁：返回 0 = 放行，>0 = 剩余锁定秒数 */
export async function loginLockedSeconds(db: D1Database, ipHash: string, nickname: string, now: number): Promise<number> {
  const row = await getAttempt(db, loginKey(ipHash, nickname))
  if (!row) return 0
  if (now - row.window_start >= LOGIN_WINDOW_MS) return 0
  if (row.fail_count < LOGIN_MAX_FAILS) return 0
  return Math.ceil((row.window_start + LOGIN_WINDOW_MS - now) / 1000)
}

/** 记一次登录失败；窗口已过期则重开窗口 */
export async function recordLoginFail(db: D1Database, ipHash: string, nickname: string, now: number): Promise<void> {
  const key = loginKey(ipHash, nickname)
  const row = await getAttempt(db, key)
  if (!row || now - row.window_start >= LOGIN_WINDOW_MS) {
    await putAttempt(db, key, 1, now, now)
  } else {
    await putAttempt(db, key, row.fail_count + 1, row.window_start, now)
  }
}

export async function clearLoginFails(db: D1Database, ipHash: string, nickname: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(loginKey(ipHash, nickname)).run()
}

/** 按尝试计数的通用滑窗（注册/云盘写共用）：返回 0 = 放行，>0 = 剩余锁定秒数 */
async function hitAttempt(db: D1Database, key: string, max: number, windowMs: number, now: number): Promise<number> {
  const row = await getAttempt(db, key)
  if (!row || now - row.window_start >= windowMs) {
    await putAttempt(db, key, 1, now, now)
    return 0
  }
  if (row.fail_count >= max) {
    return Math.ceil((row.window_start + windowMs - now) / 1000)
  }
  await putAttempt(db, key, row.fail_count + 1, row.window_start, now)
  return 0
}

/** 注册计数：返回 0 = 放行，>0 = 剩余锁定秒数 */
export async function hitRegisterLimit(db: D1Database, ipHash: string, now: number): Promise<number> {
  return hitAttempt(db, registerKey(ipHash), REGISTER_MAX, REGISTER_WINDOW_MS, now)
}

/** 云盘写限流（按尝试计数）：返回 0 = 放行，>0 = 剩余锁定秒数 */
export async function hitCloudWriteLimit(db: D1Database, userId: string, now: number): Promise<number> {
  return hitAttempt(db, cloudKey(userId), CLOUD_WRITE_MAX, CLOUD_WINDOW_MS, now)
}

/** 概率性清理过期限流行（挂在登录/注册路径） */
export async function maybeCleanupLoginAttempts(db: D1Database, now: number): Promise<void> {
  if (Math.random() >= 0.1) return
  await db.prepare('DELETE FROM login_attempts WHERE window_start < ?').bind(now - 24 * 3_600_000).run()
}
