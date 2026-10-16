import { jsonResponse, HttpError, readJsonBody, assertSameOrigin } from '../http'
import { randomId } from '../id'
import { hitPublishLimit, hitHubReadLimit, ipHashOf } from '../ratelimit'
import { requireUser, resolveSession, type ResolvedSession } from '../session'
import { getMembership } from './groups'
import type { RouteContext } from '../router'
import type { D1Database } from '../types'
import { toFolderMeta, type CloudFolderMetaRow } from './cloud'

/**
 * 关卡库 API（docs/39 §5.2，批次 H3）：公共域的浏览/详情与「云盘 → 公开」申请。
 * 快照制：申请时复制云盘内容快照；同 root_doc_id 同 scope 仅一条（部分唯一索引），
 * 他人已公开 → 409；自己已有 → 整体替换快照并重置 pending（「更新发布」）。
 * 源绑定锁定（额度模型 §3）：pending/published 期间云盘源槽位不可删除（云盘删除端点检查）。
 * 匿名可浏览与下载：列表免登录；详情每次下载计数 +1 并按 IP 限流 30/h；
 * 非 published 条目仅提交者本人与管理员可见详情（审核需要）。
 */

/** 每人同时在审（pending）条目上限（防刷审核队列） */
export const MAX_PENDING_PER_USER = 5
/** 列表分页上限 */
export const HUB_PAGE_MAX = 50
/** 申请留言长度上限 */
const NOTE_MAX = 200
const PUBLISH_BODY_MAX_BYTES = 16 * 1024

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

function nowMs(): number {
  return Date.now()
}

/** 公共域元数据（匿名列表/详情用；不含提交者 id 与审核内部字段） */
export function toPublicMeta(row: HubItemRow) {
  return {
    id: row.id,
    scope: row.scope,
    itemKind: row.item_kind,
    rootDocId: row.root_doc_id,
    title: row.title,
    levelCount: Number(row.level_count),
    bytes: Number(row.bytes),
    authorName: row.submitter_name,
    featured: Number(row.featured) === 1,
    downloads: Number(row.downloads),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
  }
}

/** 本人/审核视角元数据（含状态机字段，不含 submitter_id） */
export function toOwnMeta(row: HubItemRow) {
  return {
    ...toPublicMeta(row),
    groupId: row.group_id,
    submitterNote: row.submitter_note,
    wantFeatured: Number(row.want_featured) === 1,
    status: row.status,
    rejectReason: row.reject_reason,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 管理队列元数据（含留言与精选意愿） */
export function toAdminMeta(row: HubItemRow) {
  return toOwnMeta(row)
}

function readNote(body: Record<string, unknown>): string | null {
  if (body.note === undefined || body.note === null) return null
  if (typeof body.note !== 'string') throw new HttpError(400, 'bad_request', 'note 必须是字符串')
  const value = body.note.normalize('NFC').trim()
  if ([...value].length > NOTE_MAX) throw new HttpError(400, 'bad_request', `留言不能超过 ${NOTE_MAX} 字`)
  return value === '' ? null : value
}

function readWantFeatured(body: Record<string, unknown>): boolean {
  if (body.wantFeatured === undefined || body.wantFeatured === null) return false
  if (typeof body.wantFeatured !== 'boolean') throw new HttpError(400, 'bad_request', 'wantFeatured 必须是布尔值')
  return body.wantFeatured
}

interface PublishSource {
  rootDocId: string
  itemKind: 'level' | 'series'
  title: string
  levelCount: number
  bytes: number
  /** 已序列化的快照文档 */
  docs: { doc_id: string; kind: string; payload: string; bytes: number }[]
}

async function loadLevelSource(db: D1Database, slotId: string, userId: string): Promise<PublishSource> {
  const row = await db
    .prepare('SELECT id, user_id, level_id, title, payload, bytes, schema_version, created_at, updated_at FROM cloud_levels WHERE id = ? AND user_id = ?')
    .bind(slotId, userId)
    .first<{ level_id: string; title: string; payload: string; bytes: number } & Record<string, unknown>>()
  if (!row) throw new HttpError(404, 'not_found', '云端槽位不存在')
  return {
    rootDocId: row.level_id,
    itemKind: 'level',
    title: row.title,
    levelCount: 1,
    bytes: Number(row.bytes),
    docs: [{ doc_id: row.level_id, kind: 'level', payload: row.payload, bytes: Number(row.bytes) }],
  }
}

async function loadFolderSource(db: D1Database, slotId: string, userId: string): Promise<PublishSource> {
  const row = await db
    .prepare('SELECT id, folder_id, title, level_count, bytes, created_at, updated_at FROM cloud_folders WHERE id = ? AND user_id = ?')
    .bind(slotId, userId)
    .first<CloudFolderMetaRow & { id: string }>()
  if (!row) throw new HttpError(404, 'not_found', '云端文件夹不存在')
  const docs = await db
    .prepare('SELECT doc_id, kind, payload, bytes FROM cloud_folder_docs WHERE folder_id = ? ORDER BY doc_id')
    .bind(row.id)
    .all<{ doc_id: string; kind: string; payload: string; bytes: number }>()
  const meta = toFolderMeta(row)
  return {
    rootDocId: meta.folderId,
    itemKind: 'series',
    title: meta.title,
    levelCount: meta.levelCount,
    bytes: meta.bytes,
    docs: docs.results ?? [],
  }
}

/** 申请公开共用流程（关卡/系列两个入口）：源在云盘域，快照进公共域 */
async function applyPublish(ctx: RouteContext, loadSource: (db: D1Database, slotId: string, userId: string) => Promise<PublishSource>): Promise<Response> {
  assertSameOrigin(ctx.req)
  const body = await readJsonBody(ctx.req, PUBLISH_BODY_MAX_BYTES)
  const now = nowMs()
  const session = await requireUser(ctx.env.DB, ctx.req, now)
  const lockedSeconds = await hitPublishLimit(ctx.env.DB, session.user.id, now)
  if (lockedSeconds > 0) {
    throw new HttpError(429, 'rate_limited', `操作过于频繁，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`)
  }
  const note = readNote(body)
  const wantFeatured = readWantFeatured(body)
  const db = ctx.env.DB
  const source = await loadSource(db, ctx.params.id ?? '', session.user.id)

  const existing = await db
    .prepare("SELECT id, status, submitter_id FROM hub_items WHERE scope = 'public' AND root_doc_id = ?")
    .bind(source.rootDocId)
    .first<{ id: string; status: string; submitter_id: string | null }>()
  if (existing && existing.submitter_id !== session.user.id) {
    throw new HttpError(409, 'already_published', '该内容已被他人公开——同一内容在公共关卡库只有一份')
  }

  // 待审上限：替换自身 pending 不新增占位
  const pendingRow = await db
    .prepare("SELECT COUNT(*) AS n FROM hub_items WHERE submitter_id = ? AND status = 'pending'")
    .bind(session.user.id)
    .first<{ n: number }>()
  const pendingBefore = Number(pendingRow?.n ?? 0)
  const occupiesSlot = !(existing && existing.status === 'pending')
  if (pendingBefore + (occupiesSlot ? 1 : 0) > MAX_PENDING_PER_USER) {
    throw new HttpError(409, 'too_many_pending', `待审核的申请过多（上限 ${MAX_PENDING_PER_USER} 条），请等待审核或撤回后再试`)
  }

  const id = existing?.id ?? randomId('hub')
  await db.batch([
    db.prepare('DELETE FROM hub_item_docs WHERE item_id = ?').bind(id),
    ...(existing ? [db.prepare('DELETE FROM hub_items WHERE id = ?').bind(id)] : []),
    db
      .prepare(
        'INSERT INTO hub_items (id, scope, item_kind, root_doc_id, title, level_count, bytes, submitter_id, submitter_name, submitter_note, want_featured, status, featured, reject_reason, reviewed_by, reviewed_at, published_at, downloads, created_at, updated_at, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        'public',
        source.itemKind,
        source.rootDocId,
        source.title,
        source.levelCount,
        source.bytes,
        session.user.id,
        session.user.nickname,
        note,
        wantFeatured ? 1 : 0,
        'pending',
        0,
        null,
        null,
        null,
        null,
        0,
        now,
        now,
        null,
      ),
    ...source.docs.map((d) =>
      db.prepare('INSERT INTO hub_item_docs (item_id, doc_id, kind, payload, bytes) VALUES (?, ?, ?, ?, ?)').bind(id, d.doc_id, d.kind, d.payload, d.bytes),
    ),
  ])
  return jsonResponse({ item: { id, status: 'pending', rootDocId: source.rootDocId }, pendingCount: Math.min(pendingBefore + (occupiesSlot ? 1 : 0), MAX_PENDING_PER_USER) }, 201)
}

/** POST /api/cloud/levels/:id/publish：申请公开单关 */
export async function publishLevel(ctx: RouteContext): Promise<Response> {
  return applyPublish(ctx, loadLevelSource)
}

/** POST /api/cloud/folders/:id/publish：申请公开整个系列 */
export async function publishFolder(ctx: RouteContext): Promise<Response> {
  return applyPublish(ctx, loadFolderSource)
}

/** GET /api/hub/items?scope=public|official&featured=&query=&limit=&offset=：公开列表（匿名；H4 起官方域开放浏览） */
export async function listPublic(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.req.url)
  const scope = url.searchParams.get('scope') ?? 'public'
  if (scope !== 'public' && scope !== 'official') throw new HttpError(400, 'bad_request', '暂只支持 scope=public/official')
  const featured = url.searchParams.get('featured') === '1'
  const query = (url.searchParams.get('query') ?? '').trim().slice(0, 64)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), HUB_PAGE_MAX)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  const db = ctx.env.DB

  const cols = 'id, item_kind, root_doc_id, title, level_count, bytes, submitter_name, featured, downloads, published_at'
  const where = featured
    ? query !== ''
      ? `WHERE scope = ? AND status = 'published' AND featured = 1 AND title LIKE ?`
      : `WHERE scope = ? AND status = 'published' AND featured = 1`
    : query !== ''
      ? `WHERE scope = ? AND status = 'published' AND title LIKE ?`
      : `WHERE scope = ? AND status = 'published'`
  const args = featured ? (query !== '' ? [scope, `%${query}%`, limit, offset] : [scope, limit, offset]) : query !== '' ? [scope, `%${query}%`, limit, offset] : [scope, limit, offset]
  const list = await db.prepare(`SELECT ${cols} FROM hub_items ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`).bind(...args).all<HubItemRow>()
  const countArgs = featured ? (query !== '' ? [scope, `%${query}%`] : [scope]) : query !== '' ? [scope, `%${query}%`] : [scope]
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM hub_items ${where}`).bind(...countArgs).first<{ n: number }>()
  return jsonResponse({ items: (list.results ?? []).map(toPublicMeta), total: Number(total?.n ?? 0), limit, offset })
}

/** GET /api/hub/items/:id：条目详情（含快照文档，匿名可下已发布；pending/rejected 仅本人与管理员） */
export async function getHubItem(ctx: RouteContext): Promise<Response> {
  await assertHubReadAllowed(ctx)
  const now = nowMs()
  const db = ctx.env.DB
  const row = await db.prepare('SELECT id, submitter_id, status, group_id FROM hub_items WHERE id = ?').bind(ctx.params.id ?? '').first<{ id: string; submitter_id: string | null; status: string; group_id: string | null }>()
  if (!row) throw new HttpError(404, 'not_found', '条目不存在')

  let session: ResolvedSession | null = null
  if (row.status !== 'published') {
    session = await resolveSession(db, ctx.req, now)
    const allowed = session !== null && (session.user.role === 'admin' || session.user.id === row.submitter_id)
    if (!allowed) throw new HttpError(404, 'not_found', '条目不存在')
  }

  const full = await db
    .prepare('SELECT id, scope, item_kind, root_doc_id, title, level_count, bytes, submitter_name, featured, downloads, published_at FROM hub_items WHERE id = ?')
    .bind(row.id)
    .first<HubItemRow>()
  if (!full) throw new HttpError(404, 'not_found', '条目不存在')
  const docs = await db
    .prepare('SELECT doc_id, kind, payload, bytes FROM hub_item_docs WHERE item_id = ? ORDER BY doc_id')
    .bind(row.id)
    .all<{ doc_id: string; kind: string; payload: string; bytes: number }>()
  const outDocs = (docs.results ?? []).map((d) => {
    let payload: unknown
    try {
      payload = JSON.parse(d.payload)
    } catch {
      throw new HttpError(500, 'internal', '数据损坏，请联系管理员')
    }
    return { id: d.doc_id, kind: d.kind, payload }
  })
  if (row.status === 'published') {
    await db.prepare('UPDATE hub_items SET downloads = downloads + 1 WHERE id = ?').bind(row.id).run()
  }
  return jsonResponse({ item: toPublicMeta(full), docs: outDocs })
}

/** GET /api/hub/mine：我的申请（全状态，#/cloud 徽章数据源） */
export async function listMine(ctx: RouteContext): Promise<Response> {
  const now = nowMs()
  const session = await requireUser(ctx.env.DB, ctx.req, now)
  const rows = await ctx.env.DB
    .prepare('SELECT id, scope, item_kind, root_doc_id, title, level_count, bytes, submitter_name, submitter_note, want_featured, status, featured, reject_reason, created_at, updated_at, published_at FROM hub_items WHERE submitter_id = ? ORDER BY updated_at DESC')
    .bind(session.user.id)
    .all<HubItemRow>()
  return jsonResponse({ items: (rows.results ?? []).map(toOwnMeta) })
}

/** DELETE /api/hub/items/:id：本人撤回（pending/published 均可，删除即解锁源槽位） */
export async function withdrawItem(ctx: RouteContext): Promise<Response> {
  assertSameOrigin(ctx.req)
  const now = nowMs()
  const session = await requireUser(ctx.env.DB, ctx.req, now)
  const db = ctx.env.DB
  const row = await db.prepare('SELECT id, submitter_id, status, group_id FROM hub_items WHERE id = ?').bind(ctx.params.id ?? '').first<{ id: string; submitter_id: string | null; status: string; group_id: string | null }>()
  // 上传者本人可撤；群库条目群主亦可移除
  const isSubmitter = row !== null && row.submitter_id === session.user.id
  let isGroupOwner = false
  if (row !== null && !isSubmitter && row.group_id !== null) {
    const membership = await getMembership(db, row.group_id, session.user.id)
    isGroupOwner = membership !== null && membership.role === 'owner'
  }
  if (row === null || (!isSubmitter && !isGroupOwner)) throw new HttpError(404, 'not_found', '条目不存在')
  await db.batch([
    db.prepare('DELETE FROM hub_item_docs WHERE item_id = ?').bind(row.id),
    db.prepare('DELETE FROM hub_items WHERE id = ?').bind(row.id),
  ])
  return jsonResponse({ ok: true })
}

/** 匿名详情限流（IP 维度）辅助：hub 详情端点调用 */
export async function assertHubReadAllowed(ctx: RouteContext): Promise<void> {
  const ipHash = await ipHashOf(ctx.req, ctx.env)
  const lockedSeconds = await hitHubReadLimit(ctx.env.DB, ipHash, nowMs())
  if (lockedSeconds > 0) {
    throw new HttpError(429, 'rate_limited', `下载过于频繁，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`)
  }
}
