/**
 * 通关记录同步（docs/31 §7.1，批次 B3）：
 * - mergeProgress：单调合并纯函数（bestScore=max、passed=或、attempts=max、updatedAt=max），
 *   与服务端 ON CONFLICT MAX 同规则——幂等、可交换，多端并发收敛一致。
 * - syncProgressOnce：登录/启动时全量拉取 → 与本地逐关合并 → 差异回推（模块级防重入）。
 * - pushProgress：通关上报，fire-and-forget（失败 console.warn，绝不阻塞游玩路径）。
 * 同步状态以轻量快照 store 暴露（账户区显示一行）。本模块不得反向依赖 account/store
 * （store 会调用本模块，避免循环导入）；登录态判断由调用方完成。
 */
import { apiFetch } from '../api/client'
import { db, type ProgressRecord } from '../library/db'

interface WireRecord {
  levelId: string
  bestScore: number
  passed: number
  attempts: number
  updatedAt: number
}

export type SyncStatus = 'idle' | 'syncing' | 'ok' | 'error'

export interface SyncSnapshot {
  status: SyncStatus
  lastOkAt: number | null
}

let snapshot: SyncSnapshot = { status: 'idle', lastOkAt: null }
const listeners = new Set<() => void>()

function commit(patch: Partial<SyncSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const fn of listeners) fn()
}

export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSyncSnapshot(): SyncSnapshot {
  return snapshot
}

export function resetSyncForTests(): void {
  snapshot = { status: 'idle', lastOkAt: null }
  syncing = false
}

/** 参与合并的四个字段（不含 levelId——调用方持有） */
export interface SyncFields {
  bestScore: number
  passed: number
  attempts: number
  updatedAt: number
}

/** 单调合并：各字段取 max（local 缺失时即 cloud 本身） */
export function mergeProgress(local: SyncFields | undefined, cloud: SyncFields): SyncFields {
  if (!local) return { ...cloud }
  return {
    bestScore: Math.max(local.bestScore, cloud.bestScore),
    passed: Math.max(local.passed, cloud.passed),
    attempts: Math.max(local.attempts, cloud.attempts),
    updatedAt: Math.max(local.updatedAt, cloud.updatedAt),
  }
}

function sameFields(a: SyncFields, b: SyncFields): boolean {
  return a.bestScore === b.bestScore && a.passed === b.passed && a.attempts === b.attempts && a.updatedAt === b.updatedAt
}

function toWire(record: ProgressRecord): WireRecord {
  return { levelId: record.levelId, bestScore: record.bestScore, passed: record.passed, attempts: record.attempts, updatedAt: record.updatedAt }
}

let syncing = false

export async function syncProgressOnce(): Promise<void> {
  if (syncing) return
  syncing = true
  commit({ status: 'syncing' })
  try {
    const { records } = await apiFetch<{ records: WireRecord[] }>('/api/progress')
    const localAll = await db.progress.toArray()
    const localById = new Map(localAll.map((r) => [r.levelId, r]))
    const cloudIds = new Set(records.map((r) => r.levelId))

    // 云端 → 本地：合并后与本地不同才写（幂等，避免无谓写放大）
    // 本地 → 云端：合并结果领先于云端（或云端还没有）才回推——两端各自取最大，不回推相等值
    const toWrite: ProgressRecord[] = []
    const toPush: WireRecord[] = []
    for (const cloud of records) {
      const merged = mergeProgress(localById.get(cloud.levelId), cloud)
      const candidate: ProgressRecord = {
        levelId: cloud.levelId,
        bestScore: merged.bestScore,
        passed: merged.passed === 1 ? 1 : 0,
        attempts: merged.attempts,
        updatedAt: merged.updatedAt,
      }
      const local = localById.get(cloud.levelId)
      if (!local || !sameFields(local, candidate)) toWrite.push(candidate)
      if (!sameFields(cloud, candidate)) toPush.push(toWire(candidate))
    }
    if (toWrite.length > 0) {
      await db.transaction('rw', db.progress, async () => {
        for (const record of toWrite) await db.progress.put(record)
      })
    }

    for (const local of localAll) {
      if (cloudIds.has(local.levelId)) continue
      toPush.push(toWire(local))
    }
    for (let i = 0; i < toPush.length; i += 500) {
      await apiFetch('/api/progress', { method: 'PUT', body: { records: toPush.slice(i, i + 500) }, timeoutMs: 20_000 })
    }
    commit({ status: 'ok', lastOkAt: Date.now() })
  } catch {
    commit({ status: 'error' })
  } finally {
    syncing = false
  }
}

/** 通关上报：登录态由调用方判断；失败静默（本地 saveProgress 已落库） */
export async function pushProgress(record: ProgressRecord): Promise<void> {
  try {
    await apiFetch(
      '/api/progress',
      {
        method: 'PUT',
        body: { records: [{ levelId: record.levelId, bestScore: record.bestScore, passed: record.passed, attempts: record.attempts, updatedAt: record.updatedAt }] },
      },
    )
  } catch (err) {
    console.warn('[progress] 云端上报失败（本地已保存）:', err)
  }
}

/** 登出时复位状态展示 */
export function resetSyncStatus(): void {
  snapshot = { status: 'idle', lastOkAt: null }
}
