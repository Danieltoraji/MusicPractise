/**
 * 皮肤偏好（docs/35 §3）：localStorage 只存元数据（皮肤 id / 资产 id / 透明度等），
 * 图片与字体本体在 IndexedDB（skin/assets.ts）。全部为设备本地偏好，不同步云端。
 */

export type SkinId = 'dream' | 'violet' | 'liuhua'

export type BgScope = 'all' | 'home'
export type WmPos = 'tile' | 'center' | 'tl' | 'tr' | 'bl' | 'br'

export interface SkinPrefs {
  skinId: SkinId
  bg: { id: string | null; opacity: number; scope: BgScope }
  wm: { id: string | null; opacity: number; pos: WmPos; fade: number }
  /** 字体覆盖：null = 跟随皮肤；字符串 = 字体 family 名 */
  font: { ui: string | null; display: string | null }
}

export const SKIN_CATALOG: { id: SkinId; name: string; desc: string; fontNote: string; themeColor: string }[] = [
  {
    id: 'dream',
    name: '音乐梦旅',
    desc: '靛蓝浅色系的经典基调，优化渐变与阴影层次',
    fontNote: '默认字体',
    themeColor: '#4c51bf',
  },
  {
    id: 'violet',
    name: '紫色清春',
    desc: '以白为主，紫色与多彩点缀，明快清爽',
    fontNote: '微软雅黑',
    themeColor: '#6d28d9',
  },
  {
    id: 'liuhua',
    name: '堇庭流华',
    desc: '深蓝底、冰蓝提亮、金色点缀关键处',
    fontNote: '标题 · 汉仪文黑85W（缺字体自动回退）',
    themeColor: '#0d1530',
  },
]

export const SKIN_IDS: SkinId[] = ['dream', 'violet', 'liuhua']

export const DEFAULT_PREFS: SkinPrefs = {
  skinId: 'dream',
  bg: { id: null, opacity: 1, scope: 'all' },
  wm: { id: null, opacity: 0.5, pos: 'br', fade: 30 },
  font: { ui: null, display: null },
}

const STORAGE_KEY = 'skin.prefs.v1'

function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback
}

function asId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 80 ? v : null
}

/** 宽松归一化：任意脏输入收敛为合法偏好（损坏的 localStorage 不炸启动） */
export function normalizePrefs(raw: unknown): SkinPrefs {
  const r = (raw ?? {}) as Partial<SkinPrefs> & Record<string, unknown>
  const bg = (r.bg ?? {}) as Partial<SkinPrefs['bg']>
  const wm = (r.wm ?? {}) as Partial<SkinPrefs['wm']>
  const font = (r.font ?? {}) as Partial<SkinPrefs['font']>
  const pos = wm.pos
  return {
    skinId: SKIN_IDS.includes(r.skinId as SkinId) ? (r.skinId as SkinId) : DEFAULT_PREFS.skinId,
    bg: {
      id: asId(bg.id),
      opacity: clamp01(bg.opacity, DEFAULT_PREFS.bg.opacity),
      scope: bg.scope === 'home' ? 'home' : 'all',
    },
    wm: {
      id: asId(wm.id),
      opacity: clamp01(wm.opacity, DEFAULT_PREFS.wm.opacity),
      pos: pos === 'tile' || pos === 'center' || pos === 'tl' || pos === 'tr' || pos === 'bl' || pos === 'br' ? pos : DEFAULT_PREFS.wm.pos,
      fade: clampInt(wm.fade, 0, 100, DEFAULT_PREFS.wm.fade),
    },
    font: {
      ui: typeof font.ui === 'string' && font.ui.trim() ? font.ui.trim().slice(0, 64) : null,
      display: typeof font.display === 'string' && font.display.trim() ? font.display.trim().slice(0, 64) : null,
    },
  }
}

export function loadPrefs(): SkinPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? normalizePrefs(JSON.parse(raw)) : { ...DEFAULT_PREFS }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(prefs: SkinPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 隐私模式等写入失败不阻塞会话（本次会话内偏好仍在内存生效）
  }
}

// ---------------------------------------------------------------------------
// CSS 应用（纯 DOM 副作用，集中在 apply* 家族便于测试与失效恢复）
// ---------------------------------------------------------------------------

/** 用户字体覆盖时拼在 family 前面的兜底栈：缺字体不至于掉到 UA 默认 */
export const FONT_FALLBACK_UI = "'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif"

const WM_POS_CSS: Record<WmPos, { repeat: string; position: string; size: string }> = {
  tile: { repeat: 'repeat', position: 'top left', size: 'auto' },
  center: { repeat: 'no-repeat', position: 'center', size: '46% auto' },
  tl: { repeat: 'no-repeat', position: '24px 24px', size: '30% auto' },
  tr: { repeat: 'no-repeat', position: 'top right 24px', size: '30% auto' },
  bl: { repeat: 'no-repeat', position: 'bottom left 24px', size: '30% auto' },
  br: { repeat: 'no-repeat', position: 'bottom right 24px', size: '30% auto' },
}

export function watermarkMask(fade: number): string | 'none' {
  if (fade <= 0) return 'none'
  // 四周渐隐：视口中心的椭圆蒙版，fade 越大过渡带越宽
  const solid = Math.max(0, 100 - fade)
  return `radial-gradient(ellipse at center, black ${solid}%, transparent 100%)`
}

function setVar(name: string, value: string | null): void {
  const el = document.documentElement
  if (value === null) el.style.removeProperty(name)
  else el.style.setProperty(name, value)
}

/** 运行时解析结果（URL 等不入 localStorage） */
export interface SkinResolved {
  bgUrl?: string
  wmUrl?: string
}

export function applyPrefsToDom(prefs: SkinPrefs, resolved: SkinResolved = {}): void {
  document.documentElement.dataset.skin = prefs.skinId

  // 背景图：设置后对应区域默认背景色被图片替代（层盖住 body 的 --app-bg）
  if (resolved.bgUrl) {
    setVar('--user-bg-image', `url("${resolved.bgUrl}")`)
    setVar('--user-bg-opacity', String(prefs.bg.opacity))
  } else {
    setVar('--user-bg-image', null)
    setVar('--user-bg-opacity', null)
  }

  // 水印：位置/渐隐全部折算成 CSS 变量，层本身零逻辑
  if (resolved.wmUrl) {
    const pos = WM_POS_CSS[prefs.wm.pos]
    setVar('--wm-image', `url("${resolved.wmUrl}")`)
    setVar('--wm-repeat', pos.repeat)
    setVar('--wm-position', pos.position)
    setVar('--wm-size', pos.size)
    setVar('--wm-opacity', String(prefs.wm.opacity))
    setVar('--wm-mask', watermarkMask(prefs.wm.fade))
  } else {
    for (const v of ['--wm-image', '--wm-repeat', '--wm-position', '--wm-size', '--wm-opacity', '--wm-mask']) setVar(v, null)
  }

  // 字体覆盖：family 拼上兜底栈（皮肤栈在 --font-ui/--font-display 里）
  setVar('--user-font-ui', prefs.font.ui ? `${quoteFamily(prefs.font.ui)}, ${FONT_FALLBACK_UI}` : null)
  setVar(
    '--user-font-display',
    prefs.font.display
      ? `${quoteFamily(prefs.font.display)}, ${FONT_FALLBACK_UI}`
      : null,
  )
}

function quoteFamily(family: string): string {
  // 已带引号的 family 原样保留，其余统一加引号防字体名带空格
  return family.includes('"') || family.includes("'") ? family : `'${family}'`
}

export function applyThemeColor(skinId: SkinId): void {
  const meta = document.querySelector('meta[name="theme-color"]')
  const color = SKIN_CATALOG.find((s) => s.id === skinId)?.themeColor
  if (meta && color) meta.setAttribute('content', color)
}
