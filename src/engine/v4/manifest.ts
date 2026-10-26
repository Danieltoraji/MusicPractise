/**
 * 题单（manifest）与牌堆（deck）纯函数（docs/53 §5）。
 *
 * - 自动题单：排除 draft，按 (phase, order, 题型声明序, 行序) 排序；
 * - 显式题单：严格按 entries 顺序，draft 不影响（编辑器负责警告），phase/order 取行元数据；
 * - 牌堆：order=shuffle 时按 phase 分组洗牌（或整体洗牌），再按 count 截断，最后分配 slotIndex；
 * - seed：null → 本局随机并返回；number → 直接取 uint32；string → FNV-1a；PRNG = mulberry32。
 */
import type { DeckItem, LevelDocV4, ManifestSlot, QuestionRow, RunConfig } from './model'
import { getRow, getRowIndex, getType } from './model'

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

export interface ManifestBuild {
  slots: ManifestSlot[]
  explicit: boolean
}

function slotOf(typeId: string, row: QuestionRow, rowIndex: number, args?: ManifestSlot['args']): ManifestSlot {
  const slot: ManifestSlot = {
    type: typeId,
    row: row.id,
    phase: row.phase ?? 1,
    order: row.order ?? rowIndex,
  }
  if (args !== undefined) slot.args = args
  return slot
}

/** 自动题单（忽略显式 manifest；编辑器「自动题单预览」也用它） */
export function buildAutoManifest(doc: LevelDocV4): ManifestSlot[] {
  const keyed: { slot: ManifestSlot; typeIndex: number; rowIndex: number }[] = []
  doc.content.types.forEach((type, typeIndex) => {
    const rows = doc.content.tables[type.id]?.rows ?? []
    rows.forEach((row, rowIndex) => {
      if (row.draft === true) return
      keyed.push({ slot: slotOf(type.id, row, rowIndex), typeIndex, rowIndex })
    })
  })
  keyed.sort(
    (a, b) =>
      a.slot.phase - b.slot.phase ||
      a.slot.order - b.slot.order ||
      a.typeIndex - b.typeIndex ||
      a.rowIndex - b.rowIndex,
  )
  return keyed.map((k) => k.slot)
}

/** 显式题单：按 entries 顺序解析类型/行；悬空引用抛 ManifestError（装载校验应先行拦截） */
export function buildExplicitManifest(doc: LevelDocV4): ManifestSlot[] {
  const entries = doc.content.manifest?.entries ?? []
  return entries.map((entry) => {
    if (!getType(doc, entry.type)) {
      throw new ManifestError(`题单引用了不存在的题型 "${entry.type}"`)
    }
    const rowIndex = getRowIndex(doc, entry.type, entry.row)
    if (rowIndex < 0) {
      throw new ManifestError(`题单引用了题型 "${entry.type}" 中不存在的行 "${entry.row}"`)
    }
    const row = getRow(doc, entry.type, entry.row) as QuestionRow
    return slotOf(entry.type, row, rowIndex, entry.args)
  })
}

/** 题单：显式优先，缺省自动 */
export function buildManifest(doc: LevelDocV4): ManifestBuild {
  if (doc.content.manifest) return { slots: buildExplicitManifest(doc), explicit: true }
  return { slots: buildAutoManifest(doc), explicit: false }
}

// ---------------------------------------------------------------------------
// seed / PRNG / 洗牌
// ---------------------------------------------------------------------------

/** FNV-1a 32 位（字符串 seed 归一化） */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 把 RunConfig.seed 归一化为 uint32；null/undefined → 调用 random 生成并记录 */
export function resolveSeed(
  seed: number | string | null | undefined,
  random: () => number = Math.random,
): number {
  if (seed === null || seed === undefined) return Math.floor(random() * 0x1_0000_0000) >>> 0
  if (typeof seed === 'number') {
    return Number.isFinite(seed) ? Math.trunc(Math.abs(seed)) >>> 0 : hashSeed(String(seed))
  }
  return hashSeed(seed)
}

/** mulberry32：小而稳定的确定性 PRNG（同 seed 同序列；调试/重开可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

/** Fisher–Yates 洗牌（返回新数组） */
export function shuffleWith<T>(items: readonly T[], rnd: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/**
 * 阶段内洗牌：按 phase 分组（分组顺序 = 首次出现顺序）、组内 Fisher–Yates。
 * 用于显式题单出现跨 phase 交错时仍保持「阶段顺序不变」。
 */
export function shuffleWithinPhase(slots: readonly ManifestSlot[], rnd: () => number): ManifestSlot[] {
  const groups = new Map<number, ManifestSlot[]>()
  for (const slot of slots) {
    const group = groups.get(slot.phase)
    if (group) group.push(slot)
    else groups.set(slot.phase, [slot])
  }
  const out: ManifestSlot[] = []
  for (const group of groups.values()) out.push(...shuffleWith(group, rnd))
  return out
}

export interface BuildDeckOptions {
  /** 覆盖 run.seed（调试/重开/测试）；null = 随机 */
  seed?: number | string | null
  /** 测试注入随机源（默认 Math.random） */
  random?: () => number
}

export interface DeckBuild {
  deck: DeckItem[]
  /** 本局实际使用的 seed（run.seed 为 null 时也能复现/记录） */
  seed: number
  explicit: boolean
}

/** 生成牌堆：题单 → 洗牌（order）→ 截断（count）→ slotIndex */
export function buildDeck(doc: LevelDocV4, opts: BuildDeckOptions = {}): DeckBuild {
  const manifest = buildManifest(doc)
  let slots = manifest.slots
  const run: RunConfig = doc.content.run
  const seed = resolveSeed(opts.seed !== undefined ? opts.seed : run.seed, opts.random)
  if (run.order === 'shuffle') {
    const rnd = mulberry32(seed)
    slots = run.shuffleWithinPhase ? shuffleWithinPhase(slots, rnd) : shuffleWith(slots, rnd)
  }
  if (run.count !== null) slots = slots.slice(0, Math.max(0, Math.trunc(run.count)))
  const deck = slots.map((slot, slotIndex) => ({ ...slot, slotIndex }))
  return { deck, seed, explicit: manifest.explicit }
}
