/**
 * 服务端最小类型集（docs/31 §9 测试策略）：不引入 @cloudflare/workers-types，
 * 手写本批用到的 D1 / ASSETS / ExecutionContext 结构子集——主 tsconfig（DOM lib）
 * 即可对 worker/ 做类型检查，零新依赖。远期若用到更多 workerd 专属 API
 * （如 req.cf、waitUntil 深度用法），再评估独立 tsconfig.worker.json。
 */

/** D1 预编译语句：仅声明本批用到的方法面 */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results?: T[]; success: boolean; meta?: unknown }>
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<Array<{ results?: unknown[]; success: boolean }>>
}

/** 静态资产绑定：非 /api 路径回落用（wrangler.jsonc assets.binding = ASSETS） */
export interface AssetsBinding {
  fetch(input: Request): Promise<Response>
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

/** Worker 绑定（与 wrangler.jsonc 对齐） */
export interface Env {
  DB: D1Database
  ASSETS: AssetsBinding
  /** IP 哈希盐（`wrangler secret put IP_HASH_SALT`）；缺省用占位串，仅影响限流键的抗彩虹表强度 */
  IP_HASH_SALT?: string
}

/** API 返回的用户形态（绝不回传 pw_hash） */
export interface ApiUser {
  id: string
  nickname: string
  role: 'user' | 'admin'
}

/** users 表行（DAO 层内部形态） */
export interface UserRow {
  id: string
  nickname: string
  pw_hash: string
  role: 'user' | 'admin'
  status: 'active' | 'disabled'
  created_at: number
  updated_at: number
}
