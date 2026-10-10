import { assertSameOrigin, HttpError, jsonResponse, readJsonBody } from '../http'
import { dummyVerify, hashPassword, verifyPassword } from '../password'
import {
  clearLoginFails,
  hitRegisterLimit,
  ipHashOf,
  loginLockedSeconds,
  maybeCleanupLoginAttempts,
  recordLoginFail,
} from '../ratelimit'
import {
  clearSessionCookie,
  createSession,
  maybeCleanupSessions,
  requireUser,
  resolveSession,
  revokeOtherSessions,
  revokeSession,
  sessionCookie,
} from '../session'
import {
  findUserById,
  findUserByNickname,
  insertUser,
  isUniqueViolation,
  toApiUser,
  updateUserNickname,
  updateUserPassword,
} from '../users'
import { checkNickname, checkPassword, type ValidateResult } from '../validate'
import { newUserId } from '../id'
import type { RouteContext } from '../router'
import type { UserRow } from '../types'

/** 认证类 JSON 请求体上限：昵称/密码场景远用不到大体积（关卡上传的 512KB 上限在 B2） */
const AUTH_BODY_MAX_BYTES = 8 * 1024

function nowMs(): number {
  return Date.now()
}

function readField(body: Record<string, unknown>, key: string, check: (v: unknown) => ValidateResult): string {
  const result = check(body[key])
  if (!result.ok) throw new HttpError(400, 'bad_request', result.message)
  return result.value
}

function jsonWithCookie(data: unknown, cookie: string, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': cookie },
  })
}

/** POST /api/auth/register：注册即登录（docs/31 §5.1） */
export async function register({ req, env }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, AUTH_BODY_MAX_BYTES)
  const now = nowMs()
  const ipHash = await ipHashOf(req, env)
  const lockedSeconds = await hitRegisterLimit(env.DB, ipHash, now)
  if (lockedSeconds > 0) {
    throw new HttpError(429, 'rate_limited', `注册过于频繁，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`)
  }
  const nickname = readField(body, 'nickname', checkNickname)
  const password = readField(body, 'password', checkPassword)
  if (await findUserByNickname(env.DB, nickname)) {
    throw new HttpError(409, 'nickname_taken', '昵称已被占用')
  }
  const row: UserRow = {
    id: newUserId(),
    nickname,
    pw_hash: await hashPassword(password),
    role: 'user',
    status: 'active',
    created_at: now,
    updated_at: now,
  }
  try {
    await insertUser(env.DB, row)
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'nickname_taken', '昵称已被占用')
    throw err
  }
  await maybeCleanupSessions(env.DB, now)
  const { token } = await createSession(env.DB, row.id, now)
  return jsonWithCookie({ user: toApiUser(row) }, sessionCookie(token), 201)
}

/** POST /api/auth/login：防枚举（不存在用户走等量假派生、错误统一 401 同信封） */
export async function login({ req, env }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, AUTH_BODY_MAX_BYTES)
  const now = nowMs()
  const ipHash = await ipHashOf(req, env)
  const nickname = readField(body, 'nickname', checkNickname)
  const password = readField(body, 'password', checkPassword)
  const lockedSeconds = await loginLockedSeconds(env.DB, ipHash, nickname, now)
  if (lockedSeconds > 0) {
    throw new HttpError(429, 'rate_limited', `尝试过于频繁，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`)
  }
  const user = await findUserByNickname(env.DB, nickname)
  const passwordOk = user ? await verifyPassword(password, user.pw_hash) : false
  if (!user || !passwordOk) {
    if (!user) await dummyVerify()
    await recordLoginFail(env.DB, ipHash, nickname, now)
    throw new HttpError(401, 'invalid_credentials', '昵称或密码错误')
  }
  if (user.status !== 'active') {
    throw new HttpError(403, 'account_disabled', '账号已被停用，请联系管理员')
  }
  await clearLoginFails(env.DB, ipHash, nickname)
  await maybeCleanupSessions(env.DB, now)
  await maybeCleanupLoginAttempts(env.DB, now)
  const { token } = await createSession(env.DB, user.id, now)
  return jsonWithCookie({ user: toApiUser(user) }, sessionCookie(token))
}

/** GET /api/auth/me：未登录返回 {user:null}（200），避免启动探测刷 401 噪音 */
export async function me({ req, env }: RouteContext): Promise<Response> {
  const session = await resolveSession(env.DB, req, nowMs())
  return jsonResponse({ user: session?.user ?? null })
}

/** POST /api/auth/logout */
export async function logout({ req, env }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  await revokeSession(env.DB, req)
  return jsonWithCookie({ ok: true }, clearSessionCookie())
}

/** PATCH /api/auth/nickname */
export async function updateNickname({ req, env }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, AUTH_BODY_MAX_BYTES)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const nickname = readField(body, 'nickname', checkNickname)
  const existing = await findUserByNickname(env.DB, nickname)
  if (existing && existing.id !== session.user.id) {
    throw new HttpError(409, 'nickname_taken', '昵称已被占用')
  }
  try {
    await updateUserNickname(env.DB, session.user.id, nickname, now)
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'nickname_taken', '昵称已被占用')
    throw err
  }
  const user = await findUserById(env.DB, session.user.id)
  if (!user) throw new HttpError(401, 'unauthorized', '请先登录')
  return jsonResponse({ user: toApiUser(user) })
}

/** POST /api/auth/password：改密成功吊销其余会话（保留当前登录态） */
export async function changePassword({ req, env }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, AUTH_BODY_MAX_BYTES)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const oldPassword = readField(body, 'oldPassword', checkPassword)
  const newPassword = readField(body, 'newPassword', checkPassword)
  const row = await findUserById(env.DB, session.user.id)
  if (!row) throw new HttpError(401, 'unauthorized', '请先登录')
  if (!(await verifyPassword(oldPassword, row.pw_hash))) {
    throw new HttpError(401, 'wrong_password', '当前密码不正确')
  }
  await updateUserPassword(env.DB, row.id, await hashPassword(newPassword), now)
  await revokeOtherSessions(env.DB, row.id, session.tokenHash)
  return jsonResponse({ ok: true })
}
