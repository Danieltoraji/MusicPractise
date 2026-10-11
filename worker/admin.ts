import { HttpError } from './http'
import { randomId } from './id'
import { requireUser, type ResolvedSession } from './session'
import type { D1Database } from './types'

/**
 * 管理后台地基（docs/31 §5.4，批次 B4）：requireAdmin 权限中间件 + 审计写入。
 * 审计与操作同成败——写审计失败则整个管理操作失败（低频操作，一致性优先）；
 * 普通登录失败不进审计（login_attempts 限流表已覆盖，避免写放大）。
 */
export async function requireAdmin(db: D1Database, req: Request, now: number): Promise<ResolvedSession> {
  const session = await requireUser(db, req, now)
  if (session.user.role !== 'admin') {
    throw new HttpError(403, 'forbidden', '需要管理员权限')
  }
  return session
}

export interface AuditInput {
  actorId: string
  action: string
  targetType: 'user' | 'cloud_level'
  targetId: string
  detail?: Record<string, unknown>
}

export async function writeAudit(db: D1Database, input: AuditInput, now: number): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (id, actor_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(
      randomId('aud'),
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      now,
    )
    .run()
}
