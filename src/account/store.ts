/**
 * 账户 store（docs/31 §7）：模块级单例 + 不可变快照 + subscribe（与 debugRun 同款惯例），
 * React 侧经 useSyncExternalStore 消费。启动探测 /api/health + /api/auth/me 得出三态：
 * probing（检测中）/ available（后端在线，user 可为 null）/ unavailable（云端不可用，
 * 本地功能不受影响）。登录/注册/登出/改昵称走同一 commit 通道；busy 驱动按钮禁用。
 */
import { accountApi, type ApiUser } from './api'

export type AccountPhase = 'probing' | 'available' | 'unavailable'

export interface AccountSnapshot {
  phase: AccountPhase
  user: ApiUser | null
  /** 登录/注册/改名/改密请求进行中 */
  busy: boolean
}

let snapshot: AccountSnapshot = { phase: 'probing', user: null, busy: false }
const listeners = new Set<() => void>()

function commit(patch: Partial<AccountSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const fn of listeners) fn()
}

export function subscribeAccount(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getAccountSnapshot(): AccountSnapshot {
  return snapshot
}

let probeStarted = false

/** 应用启动探测（App 挂载时调用一次；重复调用是 no-op） */
export async function probeAccount(): Promise<void> {
  if (probeStarted) return
  probeStarted = true
  try {
    await accountApi.health()
  } catch {
    commit({ phase: 'unavailable', user: null })
    return
  }
  try {
    const { user } = await accountApi.me()
    commit({ phase: 'available', user: user ?? null })
  } catch {
    // health 通但 me 异常：按未登录处理（不影响本地功能）
    commit({ phase: 'available', user: null })
  }
}

async function runBusy(action: () => Promise<void>): Promise<void> {
  commit({ busy: true })
  try {
    await action()
  } finally {
    commit({ busy: false })
  }
}

export async function login(nickname: string, password: string): Promise<void> {
  await runBusy(async () => {
    const { user } = await accountApi.login(nickname, password)
    commit({ user })
  })
}

export async function register(nickname: string, password: string): Promise<void> {
  await runBusy(async () => {
    const { user } = await accountApi.register(nickname, password)
    commit({ user })
  })
}

export async function logout(): Promise<void> {
  await runBusy(async () => {
    await accountApi.logout()
    commit({ user: null })
  })
}

export async function updateNickname(nickname: string): Promise<void> {
  await runBusy(async () => {
    const { user } = await accountApi.updateNickname(nickname)
    commit({ user })
  })
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await runBusy(async () => {
    await accountApi.changePassword(oldPassword, newPassword)
  })
}

/** 测试辅助：彻底复位单例（探测标记 + 快照） */
export function resetAccountForTests(): void {
  probeStarted = false
  snapshot = { phase: 'probing', user: null, busy: false }
}
