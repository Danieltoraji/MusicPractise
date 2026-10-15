import { jsonResponse, HttpError, readJsonBody, assertSameOrigin } from '../http'
import { randomId } from '../id'
import { hitCloudWriteLimit } from '../ratelimit'
import { validateDocByKind } from '../schema'
import { findProtoViolation } from '../sanitize'
import { requireUser } from '../session'
import type { RouteContext } from '../router'
import type { D1Database } from '../types'
import { CLOUD_LIMIT, MAX_PAYLOAD_BYTES, LEVEL_ID_RE, readTitle, countSlots, toFolderMeta, type CloudFolderMetaRow } from './cloud'

/**
 * 云盘文件夹 API（docs/39 §5.1，批次 H2）：系列=文件夹整体上传/下载。
 * 槽位合并口径 = 关卡槽位数 + Σ(文件夹内含关卡数)，上限 CLOUD_LIMIT；
 * (user_id, folder_id) 唯一——POST 按 folderId upsert（整体替换文档，不重复占槽）。
 * 逐文档三道闸（proto 键 → 按 kind 分发信封 schema → 512KB）+ 包内闭包检查：
 * 系列引用的专题、专题引用的关卡必须全部在包内，且包内不允许存在未被引用的文档。
 * 所有按槽位 id 的读/写/删都限定 user_id，他人资源一律 404 防探测。
 */

/** 请求体上限：10 关 × 512KB + 信封/转义余量 */
const FOLDER_BODY_MAX_BYTES = 5.6 * 1024 * 1024
/** 单文件夹文档数上限：关卡受槽位约束（≤10），专题/系列留足余量并封顶防滥用 */
const MAX_FOLDER_DOCS = 32

const DOC_KINDS = ['series', 'topic', 'level'] as const
type DocKind = (typeof DOC_KINDS)[number]

interface ParsedDoc {
  id: string
  kind: DocKind
  text: string
  bytes: number
  payload: Record<string, unknown>
}

function nowMs(): number {
  return Date.now()
}

function readDocId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LEVEL_ID_RE.test(value)) {
    throw new HttpError(400, 'bad_request', `${label} 必须是合法的资源 id（res_*）`)
  }
  return value
}

/** 校验 + 序列化请求体：三道闸逐文档执行；恰含一个 series 且其 id 即 folderId */
function parseFolderBody(body: Record<string, unknown>): { folderId: string; title: string; docs: ParsedDoc[] } {
  const folderId = readDocId(body.folderId, 'folderId')
  const title = readTitle(body)
  const rawDocs = body.docs
  if (!Array.isArray(rawDocs) || rawDocs.length === 0) {
    throw new HttpError(400, 'bad_request', 'docs 必须是非空数组')
  }
  if (rawDocs.length > MAX_FOLDER_DOCS) {
    throw new HttpError(413, 'too_large', `文档数超过上限（${MAX_FOLDER_DOCS}）`)
  }
  const seen = new Set<string>()
  const docs: ParsedDoc[] = []
  let seriesCount = 0
  for (const entry of rawDocs) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new HttpError(400, 'bad_request', 'docs 条目必须是对象')
    }
    const e = entry as Record<string, unknown>
    const id = readDocId(e.id, 'docs[].id')
    if (seen.has(id)) throw new HttpError(400, 'bad_request', `docs 中存在重复的文档 id：${id}`)
    seen.add(id)
    const kind = e.kind
    if (typeof kind !== 'string' || !(DOC_KINDS as readonly string[]).includes(kind)) {
      throw new HttpError(400, 'bad_request', `docs[].kind 必须是 series/topic/level（实际: ${String(kind)}）`)
    }
    const payload = e.payload
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new HttpError(400, 'bad_request', 'docs[].payload 必须是 JSON 对象')
    }
    const p = payload as Record<string, unknown>
    const protoKey = findProtoViolation(p)
    if (protoKey) throw new HttpError(400, 'bad_request', `payload 含有不被允许的键：${protoKey}`)
    const check = validateDocByKind(kind, p)
    if (!check.ok) {
      throw new HttpError(400, 'invalid_doc', `文档 ${id} 未通过信封校验（${kind}）：${check.errors.join('；')}`)
    }
    if (p.id !== id) {
      throw new HttpError(400, 'bad_request', `payload.id 与 docs[].id 不一致（${String(p.id)} ≠ ${id}）`)
    }
    const text = JSON.stringify(p)
    const bytes = new TextEncoder().encode(text).length
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw new HttpError(413, 'too_large', `文档 ${id} 超过体积上限（${MAX_PAYLOAD_BYTES} 字节）`)
    }
    if (kind === 'series') {
      seriesCount++
      if (id !== folderId) {
        throw new HttpError(400, 'bad_request', `系列文档 id（${id}）与 folderId（${folderId}）不一致`)
      }
    }
    docs.push({ id, kind: kind as DocKind, text, bytes, payload: p })
  }
  if (seriesCount !== 1) {
    throw new HttpError(400, 'bad_request', `docs 必须恰好包含一个 series 文档（实际 ${seriesCount} 个）`)
  }
  return { folderId, title, docs }
}

/**
 * 包内闭包检查（docs/39 裁决 9 的服务端部分）：系列引用的专题、专题引用的关卡
 * 必须全部在包内（缺件拒绝）；包内不允许存在未被引用的多余文档。
 * 返回 level_count = 内含关卡数（= 槽位占用）。
 */
function checkClosure(docs: ParsedDoc[]): number {
  const series = docs.find((d) => d.kind === 'series')!
  const topics = new Map(docs.filter((d) => d.kind === 'topic').map((d) => [d.id, d]))
  const levels = new Map(docs.filter((d) => d.kind === 'level').map((d) => [d.id, d]))
  const referencedTopics = new Set<string>()
  const referencedLevels = new Set<string>()

  const topicIds = readIdList(series.payload, 'topicIds')
  for (const tid of topicIds) {
    const topic = topics.get(tid)
    if (topic === undefined) throw new HttpError(400, 'bad_request', `系列缺件：专题 ${tid} 不在包内`)
    if (referencedTopics.has(tid)) continue
    referencedTopics.add(tid)
    for (const lid of readIdList(topic.payload, 'levelIds')) {
      if (!levels.has(lid)) throw new HttpError(400, 'bad_request', `专题 ${tid} 缺件：关卡 ${lid} 不在包内`)
      referencedLevels.add(lid)
    }
  }
  for (const d of docs) {
    if (d.kind === 'topic' && !referencedTopics.has(d.id)) {
      throw new HttpError(400, 'bad_request', `文档 ${d.id} 未被系列引用，不属于该文件夹`)
    }
    if (d.kind === 'level' && !referencedLevels.has(d.id)) {
      throw new HttpError(400, 'bad_request', `文档 ${d.id} 未被任何专题引用，不属于该文件夹`)
    }
  }
  return referencedLevels.size
}

/** 从信封 content 里取 id 列表（缺失/非数组一律空——schema 已保证形态，此处防御闭包读取） */
function readIdList(doc: Record<string, unknown>, key: string): string[] {
  const content = doc.content as Record<string, unknown> | undefined
  const raw = content?.[key]
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

async function loadOwnedFolder(db: D1Database, slotId: string, userId: string): Promise<CloudFolderMetaRow> {
  const row = await db
    .prepare('SELECT id, folder_id, title, level_count, bytes, created_at, updated_at FROM cloud_folders WHERE id = ? AND user_id = ?')
    .bind(slotId, userId)
    .first<CloudFolderMetaRow>()
  if (!row) throw new HttpError(404, 'not_found', '云端文件夹不存在')
  return row
}

/** GET /api/cloud/folders：文件夹槽位列表（元数据，不含文档） */
export async function listFolders({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(env.DB, req, nowMs())
  const result = await env.DB
    .prepare('SELECT id, folder_id, title, level_count, bytes, created_at, updated_at FROM cloud_folders WHERE user_id = ? ORDER BY updated_at DESC')
    .bind(session.user.id)
    .all<CloudFolderMetaRow>()
  return jsonResponse({ folders: (result.results ?? []).map(toFolderMeta) })
}

/** POST /api/cloud/folders：上传/覆盖（按 folderId upsert，整体替换文档） */
export async function uploadFolder({ req, env }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, FOLDER_BODY_MAX_BYTES)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const lockedSeconds = await hitCloudWriteLimit(env.DB, session.user.id, now)
  if (lockedSeconds > 0) {
    throw new HttpError(429, 'rate_limited', `操作过于频繁，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`)
  }
  const { folderId, title, docs } = parseFolderBody(body)
  const levelCount = checkClosure(docs)
  const db = env.DB
  const bytes = docs.reduce((acc, d) => acc + d.bytes, 0)

  const existing = await db
    .prepare('SELECT id, level_count FROM cloud_folders WHERE user_id = ? AND folder_id = ?')
    .bind(session.user.id, folderId)
    .first<{ id: string; level_count: number }>()
  const used = await countSlots(db, session.user.id)
  const newUsed = existing ? used - Number(existing.level_count) + levelCount : used + levelCount
  if (newUsed > CLOUD_LIMIT) {
    throw new HttpError(409, 'cloud_full', `云盘已满：本次需 ${levelCount} 个槽位（合并口径 ${used}${existing ? `，覆盖后释放 ${existing.level_count}` : ''}），上限 ${CLOUD_LIMIT}——请先删除不再需要的关卡或文件夹`)
  }

  const id = existing?.id ?? randomId('cldf')
  await db.batch([
    existing
      ? db
          .prepare('UPDATE cloud_folders SET title = ?, level_count = ?, bytes = ?, updated_at = ? WHERE id = ? AND user_id = ?')
          .bind(title, levelCount, bytes, now, id, session.user.id)
      : db
          .prepare('INSERT INTO cloud_folders (id, user_id, folder_id, title, level_count, bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, session.user.id, folderId, title, levelCount, bytes, now, now),
    db.prepare('DELETE FROM cloud_folder_docs WHERE folder_id = ?').bind(id),
    ...docs.map((d) =>
      db.prepare('INSERT INTO cloud_folder_docs (folder_id, doc_id, kind, payload, bytes) VALUES (?, ?, ?, ?, ?)').bind(id, d.id, d.kind, d.text, d.bytes),
    ),
  ])
  const row = await db
    .prepare('SELECT id, folder_id, title, level_count, bytes, created_at, updated_at FROM cloud_folders WHERE id = ? AND user_id = ?')
    .bind(id, session.user.id)
    .first<CloudFolderMetaRow>()
  return jsonResponse({ folder: row ? toFolderMeta(row) : null, used: newUsed }, existing ? 200 : 201)
}

/** GET /api/cloud/folders/:id：下载（含全部文档 payload） */
export async function getFolder({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(env.DB, req, nowMs())
  const row = await loadOwnedFolder(env.DB, params.id ?? '', session.user.id)
  const result = await env.DB
    .prepare('SELECT doc_id, kind, payload, bytes FROM cloud_folder_docs WHERE folder_id = ? ORDER BY doc_id')
    .bind(row.id)
    .all<{ doc_id: string; kind: string; payload: string; bytes: number }>()
  const docs = (result.results ?? []).map((r) => {
    let payload: unknown
    try {
      payload = JSON.parse(r.payload)
    } catch {
      throw new HttpError(500, 'internal', '云端数据损坏，请联系管理员')
    }
    return { id: r.doc_id, kind: r.kind, payload }
  })
  return jsonResponse({ folder: toFolderMeta(row), docs })
}

/** DELETE /api/cloud/folders/:id（文档显式逐表删，不依赖 FK 级联） */
export async function deleteFolder({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const lockedSeconds = await hitCloudWriteLimit(env.DB, session.user.id, now)
  if (lockedSeconds > 0) {
    throw new HttpError(429, 'rate_limited', `操作过于频繁，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`)
  }
  const row = await loadOwnedFolder(env.DB, params.id ?? '', session.user.id)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cloud_folder_docs WHERE folder_id = ?').bind(row.id),
    env.DB.prepare('DELETE FROM cloud_folders WHERE id = ? AND user_id = ?').bind(row.id, session.user.id),
  ])
  return jsonResponse({ ok: true })
}
