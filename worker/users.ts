import type { ApiUser, D1Database, UserRow } from './types'

const USER_COLS = 'id, nickname, pw_hash, role, status, created_at, updated_at'

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  const row = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first<UserRow>()
  return row ?? null
}

export async function findUserByNickname(db: D1Database, nickname: string): Promise<UserRow | null> {
  // nickname 列 UNIQUE COLLATE NOCASE：等值查询大小写不敏感（与约束同语义）
  const row = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE nickname = ?`).bind(nickname).first<UserRow>()
  return row ?? null
}

export async function insertUser(db: D1Database, row: UserRow): Promise<void> {
  await db
    .prepare('INSERT INTO users (id, nickname, pw_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.nickname, row.pw_hash, row.role, row.status, row.created_at, row.updated_at)
    .run()
}

export async function updateUserNickname(db: D1Database, id: string, nickname: string, now: number): Promise<void> {
  await db.prepare('UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?').bind(nickname, now, id).run()
}

export async function updateUserPassword(db: D1Database, id: string, pwHash: string, now: number): Promise<void> {
  await db.prepare('UPDATE users SET pw_hash = ?, updated_at = ? WHERE id = ?').bind(pwHash, now, id).run()
}

export function toApiUser(row: UserRow): ApiUser {
  return { id: row.id, nickname: row.nickname, role: row.role }
}

/** D1 唯一约束冲突识别（并发注册同名兜底，转 409） */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed')
}
