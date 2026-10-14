/**
 * 皮肤状态外部存储（docs/35）：App 顶栏层与皮肤中心共用一份快照。
 * 模式与 account/store 一致——useSyncExternalStore 消费；写路径 updatePrefs 统一
 * 「归一化 → 持久化 → 通知 → 异步应用到 DOM」。资产 URL 解析属于运行时字段（rt），
 * 只存内存不落盘；解析失败（资产缺失）层自动隐藏，不阻塞会话。
 */

import { deleteSkinImage, ensureSkinFontsLoaded, resolveSkinImageUrl } from './assets'
import { applyPrefsToDom, applyThemeColor, loadPrefs, normalizePrefs, savePrefs, type SkinPrefs } from './prefs'

export interface SkinSnapshot extends SkinPrefs {
  /** 运行时解析结果（不入 localStorage） */
  rt: { bgUrl?: string; wmUrl?: string }
}

let snapshot: SkinSnapshot = { ...loadPrefs(), rt: {} }
const listeners = new Set<() => void>()

export function getSkinSnapshot(): SkinSnapshot {
  return snapshot
}

export function subscribeSkin(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(): void {
  for (const fn of listeners) fn()
}

/** 应用序号：异步解析期间用户又改了偏好时，旧结果作废（latest-wins） */
let applySeq = 0

async function applySkin(): Promise<void> {
  const seq = ++applySeq
  const prefs = snapshot
  const [bgUrl, wmUrl] = await Promise.all([
    resolveSkinImageUrl(prefs.bg.id).catch(() => undefined),
    resolveSkinImageUrl(prefs.wm.id).catch(() => undefined),
  ])
  if (seq !== applySeq) return
  await ensureSkinFontsLoaded().catch(() => [])
  if (seq !== applySeq) return
  const rt = { bgUrl, wmUrl }
  applyPrefsToDom(prefs, rt)
  applyThemeColor(prefs.skinId)
  if (snapshot.rt.bgUrl !== rt.bgUrl || snapshot.rt.wmUrl !== rt.wmUrl) {
    snapshot = { ...snapshot, rt }
    emit()
  }
}

/** 启动时装载：App 首帧后调用一次 */
export async function initSkin(): Promise<void> {
  await applySkin()
}

/** 统一写入口：皮肤中心所有改动都经此（补丁 → 归一化 → 落盘 → 通知 → 应用） */
export function updatePrefs(patch: Partial<Omit<SkinSnapshot, 'rt'>>): void {
  const { rt: _rt, ...rest } = patch as Partial<SkinSnapshot>
  snapshot = { ...normalizePrefs({ ...snapshot, ...rest }), rt: snapshot.rt }
  // 落盘前归一化：剥离 rt 运行时字段，存储里只有元数据
  savePrefs(normalizePrefs(snapshot))
  emit()
  void applySkin()
}

/** 清掉背景/水印引用并删除对应资产（皮肤中心「移除」按钮） */
export async function clearBackground(): Promise<void> {
  const id = snapshot.bg.id
  updatePrefs({ bg: { ...snapshot.bg, id: null } })
  if (id) await deleteSkinImage(id).catch(() => undefined)
}

export async function clearWatermark(): Promise<void> {
  const id = snapshot.wm.id
  updatePrefs({ wm: { ...snapshot.wm, id: null } })
  if (id) await deleteSkinImage(id).catch(() => undefined)
}
