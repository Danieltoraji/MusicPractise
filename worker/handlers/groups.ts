import { jsonResponse, HttpError, readJsonBody, assertSameOrigin } from '../http'
import { randomId } from '../id'
import { hashPassword, verifyPassword } from '../password'
import { groupJoinLockedSeconds, recordGroupJoinFail } from '../ratelimit'
import { requireUser } from '../session'
import type { RouteContext } from '../router'
import type { D1Database } from '../types'
import { parseFolderBody, checkClosure } from './cloud_folders'
import { readLevelId, readTitle, serializePayload, readPayload } from './cloud'
import { toOwnMeta, type HubItemRow } from './hub'

/**
 * 群组关卡库 API（docs/39 §5.3，批次 H5）：
 * 建群（暗号必填全局唯一 + 密码可选）→ 加入（密码试错 5 次/15 分锁定）→ 成员/审核/群库。
 * 群库复用 hub_items（scope='group'）：成员上传（单关/系列 ≤20 关）、群主或审核员批准/驳回；
 * 额度：群库 ≤100 关、单成员 ≤30 关、建群 ≤3/人（docs/39 §3，不占个人云盘）。
 * 封禁群（admin）对所有端点 403 group_banned；解散 = 删群（显式级联成员与群库条目）。
 */

export const MAX_GROUPS_PER_USER = 3
export const MAX_MEMBERS = 100
export const MAX_GROUP_ITEM_LEVELS = 20
export const MAX_GROUP_TOTAL_LEVELS = 100
export const MAX_MEMBER_TOTAL_LEVELS = 30

const NAME_MAX = 32
const CODE_MIN = 4
const CODE_MAX = 24
const INTRO_MAX = 200
const GROUP_BODY_MAX_BYTES = 5.6 * 1024 * 1024

function nowMs(): number {
  return Date.now()
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

export async function loadGroup(db: D1Database, groupId: string): Promise<GroupRow | null> {
  return db
    .prepare('SELECT id, name, join_code, join_pw_hash, intro, owner_id, status, created_at, updated_at FROM groups WHERE id = ?')
    .bind(groupId)
    .first<GroupRow>()
}

export async function getMembership(db: D1Database, groupId: string, userId: string): Promise<{ role: string } | null> {
  const row = await db
    .prepare('SELECT group_id, user_id, role FROM group_members WHERE group_id = ? AND user_id = ?')
    .bind(groupId, userId)
    .first<{ role: string }>()
  return row ?? null
}

function assertActive(group: GroupRow): void {
  if (group.status === 'banned') throw new HttpError(403, 'group_banned', '该群组已被管理员封禁')
}

function readName(body: Record<string, unknown>): string {
  if (typeof body.name !== 'string') throw new HttpError(400, 'bad_request', 'name 必须是字符串')
  const value = body.name.normalize('NFC').trim()
  if (value === '' || [...value].length > NAME_MAX) throw new HttpError(400, 'bad_request', `群名需为 1–${NAME_MAX} 字`)
  return value
}

function readJoinCode(body: Record<string, unknown>): string {
  if (typeof body.joinCode !== 'string') throw new HttpError(400, 'bad_request', 'joinCode 必须是字符串')
  const value = body.joinCode.normalize('NFC').trim()
  const len = [...value].length
  if (len < CODE_MIN || len > CODE_MAX || /\s/.test(value)) {
    throw new HttpError(400, 'bad_request', `加入暗号需为 ${CODE_MIN}–${CODE_MAX} 个不含空白的字符`)
  }
  return value
}

function readIntro(body: Record<string, unknown>): string | null {
  if (body.intro === undefined || body.intro === null) return null
  if (typeof body.intro !== 'string') throw new HttpError(400, 'bad_request', 'intro 必须是字符串')
  const value = body.intro.normalize('NFC').trim()
  if ([...value].length > INTRO_MAX) throw new HttpError(400, 'bad_request', `简介不能超过 ${INTRO_MAX} 字`)
  return value === '' ? null : value
}

/** 群密码：''=清除；其余 4–128 位；undefined/null=不修改 */
async function readPasswordForUpdate(body: Record<string, unknown>): Promise<{ set: false } | { set: true; hash: string | null }> {
  if (body.password === undefined || body.password === null) return { set: false }
  if (typeof body.password !== 'string') throw new HttpError(400, 'bad_request', 'password 必须是字符串')
  const value = body.password
  if (value === '') return { set: true, hash: null }
  if (value.length < 4 || value.length > 128) throw new HttpError(400, 'bad_request', '加入密码需为 4–128 位')
  return { set: true, hash: await hashPassword(value) }
}

async function memberCount(db: D1Database, groupId: string): Promise<number> {
  const all = await db.prepare('SELECT group_id, user_id, role, joined_at FROM group_members WHERE group_id = ? ORDER BY joined_at').bind(groupId).all<{ user_id: string }>()
  return (all.results ?? []).length
}

function toGroupMeta(group: GroupRow, role: string | null, members: number) {
  return {
    id: group.id,
    name: group.name,
    joinCode: group.join_code,
    intro: group.intro,
    ownerId: group.owner_id,
    status: group.status,
    createdAt: Number(group.created_at),
    myRole: role,
    memberCount: members,
  }
}

/** POST /api/groups：建群（≤3/人；暗号全局唯一） */
export async function createGroup({ req, env }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, 16 * 1024)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const db = env.DB
  const name = readName(body)
  const joinCode = readJoinCode(body)
  const intro = readIntro(body)
  const password = await readPasswordForUpdate(body)

  const owned = await db.prepare('SELECT COUNT(*) AS n FROM groups WHERE owner_id = ?').bind(session.user.id).first<{ n: number }>()
  if (Number(owned?.n ?? 0) >= MAX_GROUPS_PER_USER) {
    throw new HttpError(409, 'group_limit', `每人最多创建 ${MAX_GROUPS_PER_USER} 个群组`)
  }
  const codeTaken = await db.prepare('SELECT id FROM groups WHERE join_code = ?').bind(joinCode).first<{ id: string }>()
  if (codeTaken) throw new HttpError(409, 'code_taken', '该加入暗号已被占用——换一个吧')

  const id = randomId('grp')
  await db.batch([
    db
      .prepare('INSERT INTO groups (id, name, join_code, join_pw_hash, intro, owner_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, joinCode, password.set ? password.hash : null, intro, session.user.id, 'active', now, now),
    db.prepare('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').bind(id, session.user.id, 'owner', now),
  ])
  const group = await loadGroup(db, id)
  return jsonResponse({ group: toGroupMeta(group!, 'owner', 1) }, 201)
}

/** GET /api/groups/mine：我的群组（含成员数与我角色） */
export async function myGroups({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(env.DB, req, nowMs())
  const db = env.DB
  const memberships = await db.prepare('SELECT group_id, role FROM group_members WHERE user_id = ?').bind(session.user.id).all<{ group_id: string; role: string }>()
  const out = []
  for (const m of memberships.results ?? []) {
    const group = await loadGroup(db, m.group_id)
    if (!group) continue
    out.push(toGroupMeta(group, m.role, await memberCount(db, group.id)))
  }
  return jsonResponse({ groups: out })
}

/** GET /api/groups/lookup?code=：按暗号检索（banned 群对外不可见 → 404） */
export async function lookupGroup({ req, env }: RouteContext): Promise<Response> {
  await requireUser(env.DB, req, nowMs())
  const code = (new URL(req.url).searchParams.get('code') ?? '').trim()
  if (code === '') throw new HttpError(400, 'bad_request', '缺少加入暗号')
  const db = env.DB
  const idRow = await db.prepare('SELECT id FROM groups WHERE join_code = ?').bind(code).first<{ id: string }>()
  if (!idRow) throw new HttpError(404, 'not_found', '没有这个暗号对应的群组')
  const group = await loadGroup(db, idRow.id)
  if (!group || group.status === 'banned') throw new HttpError(404, 'not_found', '没有这个暗号对应的群组')
  return jsonResponse({
    group: { id: group.id, name: group.name, intro: group.intro, hasPassword: group.join_pw_hash !== null, memberCount: await memberCount(db, group.id) },
  })
}

/** POST /api/groups/:id/join {password?}：加入（密码错 403；失败 5 次/15 分锁定） */
export async function joinGroup({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, 16 * 1024)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const db = env.DB
  const group = await loadGroup(db, params.id ?? '')
  if (!group || group.status === 'banned') throw new HttpError(404, 'not_found', '群组不存在')
  if (await getMembership(db, group.id, session.user.id)) throw new HttpError(409, 'already_member', '你已是该群组成员')

  const lockedSeconds = await groupJoinLockedSeconds(db, session.user.id, group.id, now)
  if (lockedSeconds > 0) {
    throw new HttpError(429, 'rate_limited', `密码试错过多，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`)
  }
  if (group.join_pw_hash !== null) {
    const password = body.password
    if (typeof password !== 'string' || !(await verifyPassword(password, group.join_pw_hash))) {
      await recordGroupJoinFail(db, session.user.id, group.id, now)
      throw new HttpError(403, 'wrong_password', '加入密码不正确')
    }
  }
  await db.prepare('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').bind(group.id, session.user.id, 'member', now).run()
  return jsonResponse({ ok: true, role: 'member' })
}

/** POST /api/groups/:id/leave：退群（群主不可退——只能解散） */
export async function leaveGroup({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const session = await requireUser(env.DB, req, nowMs())
  const db = env.DB
  const membership = await getMembership(db, params.id ?? '', session.user.id)
  if (!membership) throw new HttpError(404, 'not_found', '你不是该群组成员')
  if (membership.role === 'owner') throw new HttpError(409, 'owner_cannot_leave', '群主不能退群——如需结束群组请解散')
  await db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').bind(params.id ?? '', session.user.id).run()
  return jsonResponse({ ok: true })
}

/** GET /api/groups/:id：群详情 + 成员列表（成员可见） */
export async function groupDetail({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(env.DB, req, nowMs())
  const db = env.DB
  const group = await loadGroup(db, params.id ?? '')
  if (!group) throw new HttpError(404, 'not_found', '群组不存在')
  const membership = await getMembership(db, group.id, session.user.id)
  if (!membership) throw new HttpError(404, 'not_found', '群组不存在')
  assertActive(group)
  const rows = await db.prepare('SELECT group_id, user_id, role, joined_at FROM group_members WHERE group_id = ? ORDER BY joined_at').bind(group.id).all<{ user_id: string; role: string; joined_at: number }>()
  const members = []
  for (const r of rows.results ?? []) {
    const user = await db.prepare('SELECT id, nickname FROM users WHERE id = ?').bind(r.user_id).first<{ nickname: string }>()
    members.push({ userId: r.user_id, nickname: user?.nickname ?? '（已注销）', role: r.role, joinedAt: Number(r.joined_at) })
  }
  return jsonResponse({ group: toGroupMeta(group, membership.role, members.length), members })
}

/** PATCH /api/groups/:id：群主修改名称/暗号/密码/简介（password '' = 清除密码） */
export async function updateGroup({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, 16 * 1024)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const db = env.DB
  const group = await loadGroup(db, params.id ?? '')
  if (!group) throw new HttpError(404, 'not_found', '群组不存在')
  const membership = await getMembership(db, group.id, session.user.id)
  if (!membership || membership.role !== 'owner') throw new HttpError(403, 'forbidden', '仅群主可修改群设置')
  assertActive(group)

  const name = body.name !== undefined ? readName(body) : group.name
  const joinCode = body.joinCode !== undefined ? readJoinCode(body) : group.join_code
  const intro = body.intro !== undefined ? readIntro(body) : group.intro
  const password = await readPasswordForUpdate(body)
  const pwHash = password.set ? password.hash : group.join_pw_hash
  await db
    .prepare('UPDATE groups SET name = ?, join_code = ?, join_pw_hash = ?, intro = ?, updated_at = ? WHERE id = ?')
    .bind(name, joinCode, pwHash, intro, now, group.id)
    .run()
  const updated = await loadGroup(db, group.id)
  return jsonResponse({ group: toGroupMeta(updated!, 'owner', await memberCount(db, group.id)) })
}

/** DELETE /api/groups/:id：群主解散（成员 + 群库条目级联清除） */
export async function disbandGroup({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const session = await requireUser(env.DB, req, nowMs())
  const db = env.DB
  const group = await loadGroup(db, params.id ?? '')
  if (!group) throw new HttpError(404, 'not_found', '群组不存在')
  const membership = await getMembership(db, group.id, session.user.id)
  if (!membership || membership.role !== 'owner') throw new HttpError(403, 'forbidden', '仅群主可解散群组')
  await deleteGroupCascade(db, group.id)
  return jsonResponse({ ok: true })
}

/** 群组级联清除：群库条目文档与条目、成员、群本身（显式逐表删，不依赖 FK） */
export async function deleteGroupCascade(db: D1Database, groupId: string): Promise<void> {
  const items = await db.prepare('SELECT id FROM hub_items WHERE group_id = ?').bind(groupId).all<{ id: string }>()
  const stmts = []
  for (const item of items.results ?? []) {
    stmts.push(db.prepare('DELETE FROM hub_item_docs WHERE item_id = ?').bind(item.id))
    stmts.push(db.prepare('DELETE FROM hub_items WHERE id = ?').bind(item.id))
  }
  stmts.push(db.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId))
  stmts.push(db.prepare('DELETE FROM groups WHERE id = ?').bind(groupId))
  await db.batch(stmts)
}

/** PATCH /api/groups/:id/members/:uid {role}：群主任免审核员（不可动群主） */
export async function setMemberRole({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, 16 * 1024)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const db = env.DB
  const group = await loadGroup(db, params.id ?? '')
  if (!group) throw new HttpError(404, 'not_found', '群组不存在')
  const me = await getMembership(db, group.id, session.user.id)
  if (!me || me.role !== 'owner') throw new HttpError(403, 'forbidden', '仅群主可管理成员')
  assertActive(group)
  const targetId = params.uid ?? ''
  if (targetId === group.owner_id) throw new HttpError(400, 'bad_request', '不能修改群主的角色')
  const target = await getMembership(db, group.id, targetId)
  if (!target) throw new HttpError(404, 'not_found', '该用户不是群组成员')
  const role = body.role
  if (role !== 'reviewer' && role !== 'member') throw new HttpError(400, 'bad_request', 'role 必须是 reviewer/member')
  await db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').bind(role, group.id, targetId).run()
  return jsonResponse({ ok: true, role })
}

/** DELETE /api/groups/:id/members/:uid：群主移除成员（不可移除群主） */
export async function removeMember({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const session = await requireUser(env.DB, req, nowMs())
  const db = env.DB
  const group = await loadGroup(db, params.id ?? '')
  if (!group) throw new HttpError(404, 'not_found', '群组不存在')
  const me = await getMembership(db, group.id, session.user.id)
  if (!me || me.role !== 'owner') throw new HttpError(403, 'forbidden', '仅群主可移除成员')
  const targetId = params.uid ?? ''
  if (targetId === group.owner_id) throw new HttpError(400, 'bad_request', '不能移除群主')
  const target = await getMembership(db, group.id, targetId)
  if (!target) throw new HttpError(404, 'not_found', '该用户不是群组成员')
  await db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').bind(group.id, targetId).run()
  return jsonResponse({ ok: true })
}

/** 群库条目元数据（成员视角） */
function toGroupItemMeta(row: HubItemRow) {
  return {
    ...toOwnMeta(row),
    submitterName: row.submitter_name,
  }
}

/** POST /api/groups/:id/items：成员上传（单关 {levelId,title,payload} / 系列包 {folderId,title,docs}）；
 *  条目 ≤20 关、群库 ≤100 关、单成员 ≤30 关；同 (group_id, root_doc_id) 重复上传重置 pending。 */
export async function uploadGroupItem({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, GROUP_BODY_MAX_BYTES)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const db = env.DB
  const group = await loadGroup(db, params.id ?? '')
  if (!group) throw new HttpError(404, 'not_found', '群组不存在')
  const membership = await getMembership(db, group.id, session.user.id)
  if (!membership) throw new HttpError(404, 'not_found', '群组不存在')
  assertActive(group)

  let rootDocId: string
  let itemKind: 'level' | 'series'
  let title: string
  let levelCount: number
  let bytes: number
  let docs: { doc_id: string; kind: string; payload: string; bytes: number }[]
  if (body.payload !== undefined) {
    const levelId = readLevelId(body)
    title = readTitle(body)
    const { text, bytes: b } = serializePayload(readPayload(body), levelId)
    rootDocId = levelId
    itemKind = 'level'
    levelCount = 1
    bytes = b
    docs = [{ doc_id: levelId, kind: 'level', payload: text, bytes: b }]
  } else {
    const parsed = parseFolderBody(body)
    levelCount = checkClosure(parsed.docs)
    rootDocId = parsed.folderId
    itemKind = 'series'
    title = parsed.title
    bytes = parsed.docs.reduce((acc, d) => acc + d.bytes, 0)
    docs = parsed.docs.map((d) => ({ doc_id: d.id, kind: d.kind, payload: d.text, bytes: d.bytes }))
  }
  if (levelCount > MAX_GROUP_ITEM_LEVELS) {
    throw new HttpError(409, 'too_big', `群库单条目最多 ${MAX_GROUP_ITEM_LEVELS} 个关卡`)
  }
  const existing = await db
    .prepare("SELECT id FROM hub_items WHERE scope = 'group' AND group_id = ? AND root_doc_id = ?")
    .bind(group.id, rootDocId)
    .first<{ id: string }>()
  const replacedCount = existing ? await levelCountOfItem(db, existing.id) : 0
  const groupLevels = Number((await db.prepare('SELECT COALESCE(SUM(level_count), 0) AS n FROM hub_items WHERE group_id = ?').bind(group.id).first<{ n: number }>())?.n ?? 0)
  const myLevels = Number(
    (await db.prepare('SELECT COALESCE(SUM(level_count), 0) AS n FROM hub_items WHERE group_id = ? AND submitter_id = ?').bind(group.id, session.user.id).first<{ n: number }>())?.n ?? 0,
  )
  const newGroupTotal = groupLevels - replacedCount + levelCount
  const newMyTotal = myLevels - (existing ? replacedCount : 0) + levelCount
  if (newGroupTotal > MAX_GROUP_TOTAL_LEVELS) {
    throw new HttpError(409, 'group_full', `群库关卡总数超限（上限 ${MAX_GROUP_TOTAL_LEVELS}）——请联系群主清理旧条目`)
  }
  if (newMyTotal > MAX_MEMBER_TOTAL_LEVELS) {
    throw new HttpError(409, 'member_full', `单成员在群库最多贡献 ${MAX_MEMBER_TOTAL_LEVELS} 个关卡`)
  }

  const id = existing?.id ?? randomId('hub')
  await db.batch([
    db.prepare('DELETE FROM hub_item_docs WHERE item_id = ?').bind(id),
    ...(existing ? [db.prepare('DELETE FROM hub_items WHERE id = ?').bind(id)] : []),
    db
      .prepare(
        'INSERT INTO hub_items (id, scope, item_kind, root_doc_id, title, level_count, bytes, submitter_id, submitter_name, submitter_note, want_featured, status, featured, reject_reason, reviewed_by, reviewed_at, published_at, downloads, created_at, updated_at, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, 'group', itemKind, rootDocId, title, levelCount, bytes, session.user.id, session.user.nickname, null, 0, 'pending', 0, null, null, null, null, 0, now, now, group.id),
    ...docs.map((d) =>
      db.prepare('INSERT INTO hub_item_docs (item_id, doc_id, kind, payload, bytes) VALUES (?, ?, ?, ?, ?)').bind(id, d.doc_id, d.kind, d.payload, d.bytes),
    ),
  ])
  return jsonResponse({ item: { id, status: 'pending', rootDocId }, groupLevels: newGroupTotal }, existing ? 200 : 201)
}

async function levelCountOfItem(db: D1Database, itemId: string): Promise<number> {
  const row = await db.prepare('SELECT level_count FROM hub_items WHERE id = ?').bind(itemId).first<{ level_count: number }>()
  return Number(row?.level_count ?? 0)
}

/** GET /api/groups/:id/items：群库列表（普通成员见 published+自己的；群主/审核员见全部） */
export async function listGroupItems({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(env.DB, req, nowMs())
  const db = env.DB
  const group = await loadGroup(db, params.id ?? '')
  if (!group) throw new HttpError(404, 'not_found', '群组不存在')
  const membership = await getMembership(db, group.id, session.user.id)
  if (!membership) throw new HttpError(404, 'not_found', '群组不存在')
  assertActive(group)
  const rows = await db
    .prepare('SELECT id, scope, item_kind, root_doc_id, title, level_count, bytes, submitter_id, submitter_name, submitter_note, want_featured, status, featured, reject_reason, created_at, updated_at, downloads, group_id FROM hub_items WHERE group_id = ? ORDER BY updated_at DESC')
    .bind(group.id)
    .all<HubItemRow>()
  const canReview = membership.role === 'owner' || membership.role === 'reviewer'
  const items = (rows.results ?? []).filter((r) => canReview || r.status === 'published' || r.submitter_id === session.user.id).map(toGroupItemMeta)
  return jsonResponse({ items, myRole: membership.role })
}

/** 群审核权限：群主或审核员 */
async function requireGroupReviewer(db: D1Database, group: GroupRow, userId: string): Promise<void> {
  const membership = await getMembership(db, group.id, userId)
  if (!membership || (membership.role !== 'owner' && membership.role !== 'reviewer')) {
    throw new HttpError(403, 'forbidden', '仅群主或审核员可审核群库条目')
  }
}

/** POST /api/groups/:id/items/:itemId/approve：批准在群内展示 */
export async function approveGroupItem({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const db = env.DB
  const group = await loadGroup(db, params.id ?? '')
  if (!group) throw new HttpError(404, 'not_found', '群组不存在')
  assertActive(group)
  await requireGroupReviewer(db, group, session.user.id)
  const row = await db.prepare('SELECT id, submitter_id, status, group_id FROM hub_items WHERE id = ?').bind(params.itemId ?? '').first<{ id: string; status: string; group_id: string | null }>()
  if (!row || row.group_id !== group.id) throw new HttpError(404, 'not_found', '条目不存在')
  if (row.status !== 'pending') throw new HttpError(409, 'not_pending', '该条目不在待审核状态')
  await db
    .prepare("UPDATE hub_items SET status = 'published', featured = ?, reviewed_by = ?, reviewed_at = ?, published_at = ?, updated_at = ? WHERE id = ?")
    .bind(0, session.user.id, now, now, now, row.id)
    .run()
  return jsonResponse({ ok: true, status: 'published' })
}

/** POST /api/groups/:id/items/:itemId/reject {reason}：驳回（理由展示给上传者） */
export async function rejectGroupItem({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, 16 * 1024)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const db = env.DB
  const group = await loadGroup(db, params.id ?? '')
  if (!group) throw new HttpError(404, 'not_found', '群组不存在')
  assertActive(group)
  await requireGroupReviewer(db, group, session.user.id)
  const row = await db.prepare('SELECT id, submitter_id, status, group_id FROM hub_items WHERE id = ?').bind(params.itemId ?? '').first<{ id: string; status: string; group_id: string | null }>()
  if (!row || row.group_id !== group.id) throw new HttpError(404, 'not_found', '条目不存在')
  if (row.status !== 'pending') throw new HttpError(409, 'not_pending', '该条目不在待审核状态')
  const reason = typeof body.reason === 'string' && body.reason.normalize('NFC').trim() !== '' ? body.reason.normalize('NFC').trim().slice(0, 200) : null
  await db
    .prepare("UPDATE hub_items SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
    .bind(reason, session.user.id, now, now, row.id)
    .run()
  return jsonResponse({ ok: true, status: 'rejected' })
}
