/**
 * 节点图编辑器：工作台面板化布局（docs/29）+ React Flow 画布 + 体验面板（运行日志/lint 列表/变量/查看脚本）。
 * doc.content.logic（GraphProgram v2）唯一真源；一切编辑 = graphOps 纯函数 → onChange 回写 doc，
 * 非法操作（on 入边、端口缺失等）由 ops 抛错 → 错误条提示、doc 不变（受控画布自动回滚）。
 * 拖动跟手：拖动中间帧走 transient 状态（不进 doc），落点一次性 moveNode 持久化。
 * 五个 dock 面板（组件库/事件管理/变量/属性/AI）平级：宽度可拖拽、可 ✕ 关闭、工具栏按钮切换，
 * 布局持久化在 localStorage（graph-panels / graph-panel-w-*）；AI 面板与属性平级挂在画布右侧并随主题换肤。
 * 默认导出（React.lazy 懒加载 @xyflow/react，不进主包）。
 */
import { Suspense, lazy, Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { LevelDoc } from '../../engine/level'
import type { GNode } from '../../engine/graphProgram'
import {
  addNode,
  connect,
  disconnect,
  lintGraphProgramDetailed,
  moveNode,
  newNodeId,
  removeGraphVariable,
  removeNode,
  renameGraphVariable,
  setGraphVariable,
  updateNode,
  type GraphProgram,
} from '../../engine/graphProgram'
import { buildPalette, buildTemplates } from './palette'
import { NODE_H, NODE_W, arrangeLayout, dagrePositions } from './layout'
import { applyNodeChangesToProgram, portFromHandle } from './changes'
import { applyTemplate } from './applyTemplate'
import { generateScript } from '../../engine/script'
import { graphCardNodeTypes, type GraphCardData, type GraphTheme, type SummaryMode } from './nodeTypes'
import { NodeContextMenu, NodeLibraryPanel } from './NodeLibrary'
import { DockPanel } from './DockPanel'
import { DebugPanel } from './DebugPanel'
import { DebugStage } from './DebugStage'
import { EventManagerPanel } from './EventManagerPanel'
import { getAiHighlight, subscribeAiHighlight } from './aiHighlight'
import { getDebugSnapshot, stopDebugRun, subscribeDebugRun, toggleDebugBreakpoint } from './debugRun'
import { NodeInspector } from './NodeInspector'
import { VariablesPanel } from './VariablesPanel'
import { CanvasMap } from './CanvasMap'
import { clearRunLog, readRunLog } from '../../runtime/runLog'

interface Props {
  doc: LevelDoc
  onChange: (doc: LevelDoc) => void
  /** AI 助手总开关（EditorPage 单一真源：工具栏「🤖 AI」与各 tab 面板共用） */
  aiOpen: boolean
  onToggleAi: () => void
}

/** AI 助手面板在图工作台内的入坞形态（与属性平级挂画布右侧，随 ge-* 主题换肤）；会话 store 保证与其它 tab 连续 */
const AiPanel = lazy(() => import('../ai/AiPanel').then((m) => ({ default: m.AiPanel })))

// ---------------------------------------------------------------------------
// dock 布局（docs/29 追加：面板自由调换）：三个列槽 × 五面板归属 + 显隐 + 列宽/面板高，localStorage 持久化
// ---------------------------------------------------------------------------

type PanelId = 'library' | 'events' | 'vars' | 'inspector' | 'debug' | 'ai'
type ColKey = 'left' | 'rightA' | 'rightB'
type DockLayout = Record<ColKey, PanelId[]>

const ALL_PANELS: PanelId[] = ['library', 'events', 'vars', 'inspector', 'debug', 'ai']
const DEFAULT_LAYOUT: DockLayout = { left: ['library', 'events', 'vars'], rightA: ['inspector'], rightB: ['debug', 'ai'] }
const DEFAULT_COL_OF: Record<PanelId, ColKey> = {
  library: 'left',
  events: 'left',
  vars: 'left',
  inspector: 'rightA',
  debug: 'rightB',
  ai: 'rightB',
}
/** 调试面板默认收起（工具栏 🐞 打开）；其余面板默认可见 */
const DEFAULT_HIDDEN: Partial<Record<PanelId, boolean>> = { debug: true }

const DOCK_KEY = 'graph-dock'
const HEIGHTS_KEY = 'graph-dock-h'
const DEFAULT_PANEL_H = 300
const W_LEFT_KEY = 'graph-panel-w-left'
const W_INSP_KEY = 'graph-panel-w-insp'
const W_AI_KEY = 'graph-panel-w-ai'

interface DockState {
  layout: DockLayout
  hidden: Partial<Record<PanelId, boolean>>
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** 布局自愈：未知面板剔除、缺失面板回落默认槽、去重，保证五面板恰好各出现一次 */
function sanitizeLayout(raw: unknown): DockLayout {
  const out: DockLayout = { left: [], rightA: [], rightB: [] }
  if (typeof raw === 'object' && raw !== null) {
    const seen = new Set<PanelId>()
    for (const col of ['left', 'rightA', 'rightB'] as ColKey[]) {
      const ids = (raw as Record<string, unknown>)[col]
      if (!Array.isArray(ids)) continue
      for (const id of ids) {
        if (ALL_PANELS.includes(id as PanelId) && !seen.has(id as PanelId)) {
          seen.add(id as PanelId)
          out[col].push(id as PanelId)
        }
      }
    }
    for (const id of ALL_PANELS) if (!seen.has(id)) out[DEFAULT_COL_OF[id]].push(id)
  } else {
    return { left: [...DEFAULT_LAYOUT.left], rightA: [...DEFAULT_LAYOUT.rightA], rightB: [...DEFAULT_LAYOUT.rightB] }
  }
  return out
}

/** 加载 dock 状态：无存档时调试面板默认收起（DEFAULT_HIDDEN），其余可见 */
function loadDock(): DockState {
  const state: DockState = { layout: sanitizeLayout(null), hidden: { ...DEFAULT_HIDDEN } }
  try {
    // 旧键 graph-panels（面板化首版的显隐布尔）迁移
    const legacy = JSON.parse(localStorage.getItem('graph-panels') ?? 'null') as Record<string, unknown> | null
    if (legacy) {
      for (const id of ALL_PANELS) if (legacy[id] === false) state.hidden[id] = true
    }
    const raw = JSON.parse(localStorage.getItem(DOCK_KEY) ?? 'null') as { layout?: unknown; hidden?: unknown } | null
    if (raw) {
      state.layout = sanitizeLayout(raw.layout)
      if (typeof raw.hidden === 'object' && raw.hidden !== null) {
        for (const id of ALL_PANELS) if ((raw.hidden as Record<string, unknown>)[id] === false) state.hidden[id] = false
        for (const id of ALL_PANELS) if ((raw.hidden as Record<string, unknown>)[id] === true) state.hidden[id] = true
      }
    }
  } catch {
    // 毒数据：回落默认
  }
  return state
}

function loadHeights(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? 'null') as Record<string, unknown> | null
    if (!raw) return {}
    const out: Record<string, number> = {}
    for (const id of ALL_PANELS) {
      const v = Number(raw[id])
      if (Number.isFinite(v) && v > 0) out[id] = clamp(Math.round(v), 140, 900)
    }
    return out
  } catch {
    return {}
  }
}

/** 列宽持久化：读时钳制防坏数据，写时随拖拽 write-through（值小、频次可接受） */
function usePanelWidth(key: string, def: number, min: number, max: number): [number, (w: number) => void] {
  const [w, setW] = useState<number>(() => {
    const raw = Number(localStorage.getItem(key))
    return Number.isFinite(raw) && raw > 0 ? clamp(Math.round(raw), min, max) : def
  })
  const update = useCallback(
    (next: number) => {
      const v = clamp(Math.round(next), min, max)
      setW(v)
      try {
        localStorage.setItem(key, String(v))
      } catch {
        // 隐私模式等：布局降级为不持久化
      }
    },
    [key, min, max],
  )
  return [w, update]
}

/**
 * 拖拽分隔条（垂直/水平通用）：window 级监听（setPointerCapture 仅作保险，失败不阻断——
 * 合成事件/特殊环境下 capture 会因非活跃 pointerId 抛错）。
 * onTotal 回调收「自按下起点的总位移」；调用方必须在 pointerdown 时捕获起始尺寸——
 * 逐事件把总位移累加到已更新的当前值上，会在 React 渲染滞后时复利漂移（边缘跑得比鼠标快）。
 */
function startSplitDrag(e: React.PointerEvent<HTMLDivElement>, axis: 'x' | 'y', onTotal: (d: number) => void): void {
  e.preventDefault()
  const el = e.currentTarget
  el.classList.add('is-dragging')
  try {
    el.setPointerCapture(e.pointerId)
  } catch {
    // 非活跃指针（自动化合成事件等）：window 监听已足够
  }
  const start = axis === 'x' ? e.clientX : e.clientY
  const move = (ev: PointerEvent): void => onTotal((axis === 'x' ? ev.clientX : ev.clientY) - start)
  const up = (): void => {
    el.classList.remove('is-dragging')
    try {
      el.releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

const NO_POSITIONS = new Map<string, { x: number; y: number }>()

function GraphEditorInner({ doc, onChange, aiOpen, onToggleAi }: Props) {
  const program = doc.content.logic
  const rf = useReactFlow()
  // 深色工作台 / 浅色主题，与节点摘要中英文显示模式（均记忆在 localStorage）
  const [theme, setTheme] = useState<GraphTheme>(() => (localStorage.getItem('graph-theme') === 'light' ? 'light' : 'dark'))
  const [summaryMode, setSummaryMode] = useState<SummaryMode>(() =>
    localStorage.getItem('graph-summary-mode') === 'zh' ? 'zh' : 'en',
  )
  const toggleTheme = (): void => {
    setTheme((t) => {
      const next: GraphTheme = t === 'dark' ? 'light' : 'dark'
      localStorage.setItem('graph-theme', next)
      return next
    })
  }
  const toggleSummary = (): void => {
    setSummaryMode((m) => {
      const next: SummaryMode = m === 'zh' ? 'en' : 'zh'
      localStorage.setItem('graph-summary-mode', next)
      return next
    })
  }
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // dock 布局：列槽归属 + 显隐 + 列宽/面板高（docs/29 追加：跨会话记住工作台布局）
  const [dock, setDock] = useState<DockState>(loadDock)
  const [heights, setHeights] = useState<Record<string, number>>(loadHeights)
  const [leftW, setLeftW] = usePanelWidth(W_LEFT_KEY, 200, 150, 360)
  const [inspW, setInspW] = usePanelWidth(W_INSP_KEY, 300, 240, 460)
  const [aiW, setAiW] = usePanelWidth(W_AI_KEY, 360, 280, 520)
  const leftWRef = useRef(leftW)
  leftWRef.current = leftW
  const inspWRef = useRef(inspW)
  inspWRef.current = inspW
  const aiWRef = useRef(aiW)
  aiWRef.current = aiW
  const heightsRef = useRef(heights)
  heightsRef.current = heights

  const saveDock = useCallback((next: DockState): void => {
    setDock(next)
    try {
      localStorage.setItem(DOCK_KEY, JSON.stringify(next))
    } catch {
      // 布局持久化降级
    }
  }, [])
  const togglePanel = useCallback(
    (id: PanelId): void => {
      saveDock({ ...dock, hidden: { ...dock.hidden, [id]: !dock.hidden[id] } })
    },
    [dock, saveDock],
  )
  const setPanelH = useCallback((id: PanelId, h: number): void => {
    const next = { ...heightsRef.current, [id]: clamp(Math.round(h), 140, 900) }
    heightsRef.current = next
    setHeights(next)
    try {
      localStorage.setItem(HEIGHTS_KEY, JSON.stringify(next))
    } catch {
      // ignore
    }
  }, [])

  // 面板拖换（HTML5 DnD）：dragId = 拖动中的面板；hint = 插入线位置（列 + 可见序）
  const [dragId, setDragId] = useState<PanelId | null>(null)
  const [hint, setHint] = useState<{ col: ColKey; index: number } | null>(null)
  const panelVisible = useCallback(
    (id: PanelId): boolean => (id === 'ai' ? aiOpen : !dock.hidden[id]),
    [aiOpen, dock.hidden],
  )
  const visibleIn = useCallback(
    (col: ColKey): PanelId[] => dock.layout[col].filter(panelVisible),
    [dock.layout, panelVisible],
  )
  const colOf = useCallback(
    (id: PanelId): ColKey => (['left', 'rightA', 'rightB'] as ColKey[]).find((c) => dock.layout[c].includes(id)) ?? 'left',
    [dock.layout],
  )
  const movePanel = useCallback(
    (id: PanelId, col: ColKey, visIndex: number): void => {
      // 可见序 → 全量数组插入位（跳过隐藏面板）
      const fullIndex = (target: ColKey): number => {
        let count = 0
        for (let i = 0; i < dock.layout[target].length; i++) {
          if (panelVisible(dock.layout[target][i])) {
            if (count === visIndex) return i
            count++
          }
        }
        return dock.layout[target].length
      }
      const from = colOf(id)
      const layout: DockLayout = { left: [...dock.layout.left], rightA: [...dock.layout.rightA], rightB: [...dock.layout.rightB] }
      if (from === col) {
        const ids = layout[col]
        const oldIdx = ids.indexOf(id)
        const idx = fullIndex(col)
        ids.splice(oldIdx, 1)
        ids.splice(oldIdx < idx ? idx - 1 : idx, 0, id)
      } else {
        layout[from] = layout[from].filter((x) => x !== id)
        layout[col].splice(Math.min(fullIndex(col), layout[col].length), 0, id)
      }
      if (JSON.stringify(layout) !== JSON.stringify(dock.layout)) saveDock({ ...dock, layout })
    },
    [dock, colOf, panelVisible, saveDock],
  )
  const onPanelDragStart = useCallback((id: PanelId): void => setDragId(id), [])
  const onPanelDragEnd = useCallback((): void => {
    setDragId(null)
    setHint(null)
  }, [])
  const headerDragOver = useCallback(
    (e: React.DragEvent, id: PanelId): void => {
      if (!dragId || dragId === id) return
      e.preventDefault()
      e.stopPropagation()
      const col = colOf(id)
      const ids = visibleIn(col)
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const after = e.clientY >= rect.top + rect.height / 2
      setHint({ col, index: ids.indexOf(id) + (after ? 1 : 0) })
    },
    [dragId, colOf, visibleIn],
  )
  const colDragOver = useCallback(
    (e: React.DragEvent, col: ColKey): void => {
      if (!dragId) return
      e.preventDefault()
      setHint((cur) => (cur && cur.col === col ? cur : { col, index: visibleIn(col).length }))
    },
    [dragId, visibleIn],
  )
  const colDrop = useCallback(
    (e: React.DragEvent, col: ColKey): void => {
      e.preventDefault()
      if (!dragId) return
      const index = hint && hint.col === col ? hint.index : visibleIn(col).length
      movePanel(dragId, col, index)
      setDragId(null)
      setHint(null)
    },
    [dragId, hint, movePanel, visibleIn],
  )
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null)
  const [dragPos, setDragPos] = useState<Map<string, { x: number; y: number }>>(new Map())
  const [showIssues, setShowIssues] = useState(false)
  const [showScript, setShowScript] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [showMap, setShowMap] = useState(true)
  const [mapFocus, setMapFocus] = useState<string | null>(null)
  const [logTick, setLogTick] = useState(0) // 手动刷新日志读取
  const [scriptError, setScriptError] = useState<string | null>(null)

  const palette = useMemo(() => buildPalette(doc), [doc])
  // 调试状态（docs/30）：断点印在节点卡圆点、暂停节点高亮
  const debugSnap = useSyncExternalStore(subscribeDebugRun, getDebugSnapshot)
  const breakpointSet = useMemo(() => new Set(debugSnap.breakpoints), [debugSnap.breakpoints])
  // 调试布局（批次9 可视化）：会话激活时工作台整体切换——左区画面/节点图二选一，右侧调试+AI 列
  const [dbgPane, setDbgPane] = useState<'stage' | 'graph'>('stage')
  const [dbgRightW, setDbgRightW] = usePanelWidth('graph-dock-dbg-w', 380, 280, 560)
  const [dbgDebugH, setDbgDebugH] = usePanelWidth('graph-dock-dbg-h', 340, 180, 700)
  const stageSessionNo = debugSnap.stage?.sessionNo ?? 0
  useEffect(() => {
    if (stageSessionNo > 0) setDbgPane('stage') // 新会话启动（人或 AI）自动亮出画面
  }, [stageSessionNo])
  // AI 高亮（批次5）：highlight_nodes 工具指认的节点发光 + 画布自动定位
  const aiHl = useSyncExternalStore(subscribeAiHighlight, getAiHighlight)
  const aiHlSet = useMemo(() => new Set(aiHl.ids), [aiHl.ids])
  useEffect(() => {
    if (aiHl.ids.length > 0) focusNode(aiHl.ids[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiHl.ids.join(',')])
  const templates = useMemo(() => buildTemplates(doc), [doc])
  const compsInfo = useMemo(
    () => doc.content.components.map((c) => ({ id: c.id, name: c.name, type: c.type })),
    [doc],
  )
  // 组件清单版本号：改名/增删使节点卡缓存失效（评审 P2-7，当前图页不改组件、防患未然）
  const compsSig = useMemo(
    () => doc.content.components.map((c) => `${c.id}:${c.name ?? ''}`).join(','),
    [doc],
  )
  // 画布对照图焦点组件 → 图中引用它的节点（on 该组件事件 / call 它 / assign 查询它）
  const relatedIds = useMemo(() => {
    const set = new Set<string>()
    if (!mapFocus) return set
    for (const n of program.nodes) {
      if (n.kind === 'call' && n.target === mapFocus) set.add(n.id)
      else if (n.kind === 'assign' && 'call' in n.value && n.value.call.target === mapFocus) set.add(n.id)
      else if (n.kind === 'on' && (n.event.startsWith(`${mapFocus}.`) || n.event.startsWith(`${mapFocus}:`))) set.add(n.id)
    }
    return set
  }, [mapFocus, program])
  const lintIssues = useMemo(
    () =>
      lintGraphProgramDetailed(program, {
        componentIds: doc.content.components.map((c) => c.id),
        componentTypes: Object.fromEntries(doc.content.components.map((c) => [c.id, c.type])),
        viewIds: doc.content.views.map((v) => v.id),
        tableColumns: doc.content.table.columns,
      }),
    [program, doc],
  )
  const issuesByNode = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const issue of lintIssues) {
      if (!issue.nodeId) continue
      const list = map.get(issue.nodeId) ?? []
      list.push(issue.field ? `${issue.field}: ${issue.message}` : issue.message)
      map.set(issue.nodeId, list)
    }
    return map
  }, [lintIssues])

  /** graphOps 变换 → 回写 doc；抛错转错误条（画布受控回滚）。返回是否成功（供表单还原输入） */
  const apply = useCallback(
    (fn: (prog: GraphProgram) => GraphProgram): boolean => {
      try {
        const logic = fn(doc.content.logic)
        setError(null)
        if (logic !== doc.content.logic) onChange({ ...doc, content: { ...doc.content, logic } })
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
    },
    [doc, onChange],
  )

  const rootRef = useRef<HTMLDivElement>(null)
  // 全屏态走 React state：根节点 className 是受控的，classList 直接挂的 is-fullscreen
  // 会在任意重渲染（如切主题）时被覆盖丢失——根节点丢背景色，:fullscreen 黑背板透出
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement != null)
  useEffect(() => {
    const sync = (): void => setFullscreen(document.fullscreenElement != null)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const addOnNode = useCallback(
    (event: string): void => {
      apply((prog) => addNode(prog, { kind: 'on', event, id: newNodeId(prog) } as GNode))
    },
    [apply],
  )
  /** 事件管理器「emit」动作：落一个派发该内部事件的 emit 节点（参数留默认，Inspector 里补 payload） */
  const addEmitNode = useCallback(
    (event: string): void => {
      apply((prog) => addNode(prog, { kind: 'emit', event, id: newNodeId(prog) } as GNode))
    },
    [apply],
  )

  const hasMissing = useMemo(() => program.nodes.some((n) => n.x === undefined || n.y === undefined), [program])
  const fallbackPos = useMemo(() => (hasMissing ? dagrePositions(program) : NO_POSITIONS), [program, hasMissing])

  const nodeCacheRef = useRef<{ map: Map<string, Node<GraphCardData>>; sig: Map<string, string> }>({
    map: new Map(),
    sig: new Map(),
  })
  const rfNodes: Node<GraphCardData>[] = useMemo(() => {
    const { map: prevMap, sig: prevSig } = nodeCacheRef.current
    const nextMap = new Map<string, Node<GraphCardData>>()
    const nextSig = new Map<string, string>()
    const list = program.nodes.map((node) => {
      const drag = dragPos.get(node.id)
      const base: { x: number; y: number } | undefined =
        drag ?? (node.x !== undefined && node.y !== undefined ? { x: node.x, y: node.y } : fallbackPos.get(node.id))
      const position = { x: base?.x ?? 0, y: base?.y ?? 0 }
      const errors = issuesByNode.get(node.id)
      const related = relatedIds.has(node.id)
      const bp = breakpointSet.has(node.id)
      const paused = debugSnap.pausedAt === node.id
      const aihl = aiHlSet.has(node.id)
      const signature = `${JSON.stringify(node)}|${JSON.stringify(errors ?? [])}|${position.x},${position.y}|${drag ? 'drag' : 'doc'}|${related ? 'r' : ''}|${compsSig}|${theme}|${summaryMode}|${bp ? 'b' : ''}|${paused ? 'p' : ''}|${aihl ? 'a' : ''}`
      const prev = prevMap.get(node.id)
      if (prev && prevSig.get(node.id) === signature) {
        nextMap.set(node.id, prev)
        nextSig.set(node.id, signature)
        return prev
      }
      const created: Node<GraphCardData> = {
        id: node.id,
        type: 'graphCard',
        position,
        data: { node, errors, comps: compsInfo, related, theme, summaryMode, bp, paused, aihl, onToggleBp: toggleDebugBreakpoint },
        width: NODE_W,
        height: NODE_H,
        // 预置 measured：节点尺寸固定，首帧即可拖拽（否则 RF 拖拽检查报 #015）
        measured: { width: NODE_W, height: NODE_H },
      }
      nextMap.set(node.id, created)
      nextSig.set(node.id, signature)
      return created
    })
    nodeCacheRef.current = { map: nextMap, sig: nextSig }
    return list
  }, [program, fallbackPos, issuesByNode, dragPos, compsInfo, compsSig, relatedIds, breakpointSet, debugSnap.pausedAt, aiHlSet])

  const rfEdges: Edge[] = useMemo(
    () =>
      program.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle: e.port ?? 'out',
        targetHandle: 'in',
        className: e.port ? `gedge gedge-${e.port}` : 'gedge',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: e.port === 'true' ? '#34d399' : e.port === 'false' ? '#f87171' : '#5b6f96',
        },
      })),
    [program.edges],
  )

  /** 选中节点并把视口中心移到它（lint 列表/运行日志的定位入口） */
  const focusNode = useCallback(
    (id: string): void => {
      setSelectedId(id)
      const node = program.nodes.find((n) => n.id === id)
      const base: { x: number; y: number } | undefined =
        node?.x !== undefined && node?.y !== undefined ? { x: node.x, y: node.y } : fallbackPos.get(id)
      if (base) rf.setCenter(base.x + NODE_W / 2, base.y + NODE_H / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 300 })
    },
    [program, fallbackPos, rf],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<GraphCardData>>[]): void => {
      const dragging = changes.filter((c) => c.type === 'position' && c.dragging === true && c.position)
      if (dragging.length > 0) {
        setDragPos((cur) => {
          const next = new Map(cur)
          for (const c of dragging) {
            if (c.type === 'position' && c.position) {
              next.set(c.id, { x: c.position.x, y: c.position.y })
            }
          }
          return next
        })
      }
      // dimensions（RF DOM 测量回传）：合并进缓存的视图节点（视图态，不落 program），
      // 否则 store 缺 measured，拖拽时报 #015
      const dims = changes.filter((c) => c.type === 'dimensions')
      if (dims.length > 0) {
        for (const c of dims) {
          if (c.type !== 'dimensions') continue
          const cached = nodeCacheRef.current.map.get(c.id)
          if (cached) {
            cached.measured = { width: c.dimensions?.width ?? NODE_W, height: c.dimensions?.height ?? NODE_H }
          }
        }
      }
      const settle = changes.filter((c) => (c.type === 'position' && c.dragging === false) || c.type === 'remove')
      if (settle.length === 0) return
      // 单基线批量应用（避免每条 change 以过期 prog 为起点）
      apply((prog) =>
        applyNodeChangesToProgram(prog, settle as { type: string; id: string; dragging?: boolean; position?: { x: number; y: number } }[], {
          moveNode,
          removeNode,
        }),
      )
      setDragPos(new Map())
      for (const c of settle as { type: string; id: string }[]) {
        if (c.type === 'remove') setSelectedId((cur) => (cur === c.id ? null : cur))
      }
    },
    [apply],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]): void => {
      const removed = changes.filter((c) => c.type === 'remove')
      if (removed.length === 0) return
      apply((prog) => {
        let cur = prog
        for (const c of removed as { id: string }[]) cur = disconnect(cur, c.id)
        return cur
      })
    },
    [apply],
  )

  const onConnect = useCallback(
    (params: { source: string; target: string; sourceHandle: string | null }): void => {
      apply((prog) => connect(prog, params.source, params.target, portFromHandle(params.sourceHandle)))
    },
    [apply],
  )

  const addFromPalette = useCallback(
    (item: (typeof palette)[number]['items'][number], pos?: { x: number; y: number }): void => {
      apply((prog) => addNode(prog, { ...item.make(pos), id: newNodeId(prog) } as GNode))
    },
    [apply],
  )

  const addTemplate = useCallback(
    (tpl: (typeof templates)[number], pos?: { x: number; y: number }): void => {
      apply((prog) => applyTemplate(prog, tpl, pos))
    },
    [apply],
  )

  const selected = selectedId ? program.nodes.find((n) => n.id === selectedId) : undefined
  const selectedIssues = selectedId ? lintIssues.filter((i) => i.nodeId === selectedId) : []

  // 查看脚本：generateScript 对非结构化图抛错——错误消息本身就是教学信息
  const scriptText = useMemo(() => {
    if (!showScript) return null
    try {
      return { text: generateScript(program), error: null as string | null }
    } catch (err) {
      return { text: null, error: err instanceof Error ? err.message : String(err) }
    }
  }, [showScript, program])

  // 无条件读取：收起时工具条「运行日志（N）」的计数才是「有错误待查看」的注意力信号
  const runLog = useMemo(() => readRunLog(doc.id).slice().reverse(), [doc.id, logTick])
  const errorCount = runLog.filter((e) => e.kind === 'error').length

  // dock 列渲染：面板堆叠 + 面板间水平分隔条（上方面板定高可调，末面板填充剩余高度）+ DnD 插入线
  const colWidth = (col: ColKey): number => (col === 'left' ? leftW : col === 'rightA' ? inspW : aiW)
  const colWRefOf = (col: ColKey): { current: number } => (col === 'left' ? leftWRef : col === 'rightA' ? inspWRef : aiWRef)
  const colSetW = (col: ColKey, n: number): void => (col === 'left' ? setLeftW(n) : col === 'rightA' ? setInspW(n) : setAiW(n))

  const renderDockPanel = (id: PanelId, fixedHeight: boolean): React.ReactNode => {
    const style = fixedHeight ? { height: heights[id] ?? DEFAULT_PANEL_H } : undefined
    const srcClass = dragId === id ? 'drag-src' : ''
    const drag = {
      dragId: id,
      onDragStart: () => onPanelDragStart(id),
      onDragEnd: onPanelDragEnd,
      onHeaderDragOver: (e: React.DragEvent) => headerDragOver(e, id),
    }
    switch (id) {
      case 'library':
        return (
          <DockPanel key={id} icon="🧩" title="组件库" {...drag} style={style} className={srcClass} onClose={() => togglePanel('library')}>
            <NodeLibraryPanel
              groups={palette}
              templates={templates}
              onPick={(item) => addFromPalette(item)}
              onPickTemplate={(tpl) => addTemplate(tpl)}
            />
          </DockPanel>
        )
      case 'events':
        return (
          <DockPanel key={id} icon="⚡" title="事件管理" {...drag} style={style} className={srcClass} onClose={() => togglePanel('events')}>
            <EventManagerPanel doc={doc} onAddOn={addOnNode} onAddEmit={addEmitNode} onFocusNode={focusNode} />
          </DockPanel>
        )
      case 'vars':
        return (
          <DockPanel key={id} icon="🧮" title="变量" {...drag} style={style} className={srcClass} onClose={() => togglePanel('vars')}>
            <VariablesPanel
              prog={program}
              onSet={(name, value) => apply((prog) => setGraphVariable(prog, name, value))}
              onRename={(oldName, newName) => apply((prog) => renameGraphVariable(prog, oldName, newName))}
              onRemove={(name) => apply((prog) => removeGraphVariable(prog, name))}
            />
          </DockPanel>
        )
      case 'inspector':
        return (
          <DockPanel key={id} icon="⚙" title="属性" {...drag} style={style} className={srcClass} onClose={() => togglePanel('inspector')}>
            <NodeInspector
              node={selected}
              doc={doc}
              issues={selectedIssues}
              onPatch={(patch) => selectedId && apply((prog) => updateNode(prog, selectedId, patch))}
              onRemove={() => {
                if (selectedId) apply((prog) => removeNode(prog, selectedId))
                setSelectedId(null)
              }}
            />
          </DockPanel>
        )
      case 'debug':
        return (
          <DockPanel key={id} icon="🐞" title="调试" {...drag} style={style} className={srcClass} onClose={() => togglePanel('debug')}>
            <DebugPanel doc={doc} onFocusNode={focusNode} />
          </DockPanel>
        )
      case 'ai':
        return (
          <Suspense key={id} fallback={<aside className="ai-panel ai-panel-loading">AI 面板加载中…</aside>}>
            <AiPanel
              doc={doc}
              selection={{ tab: 'graph', nodeId: selectedId }}
              onClose={onToggleAi}
              onApplyDoc={onChange}
              style={style}
              className={srcClass}
              headerDrag={{
                onDragStart: () => onPanelDragStart('ai'),
                onDragEnd: onPanelDragEnd,
                onDragOver: (e) => headerDragOver(e, 'ai'),
              }}
            />
          </Suspense>
        )
    }
  }

  const renderDockCol = (col: ColKey): React.ReactNode => {
    const ids = visibleIn(col)
    return (
      <div
        className={`graph-dock-col${dragId ? ' drop-target' : ''}`}
        style={{ width: colWidth(col) }}
        onDragOver={(e) => colDragOver(e, col)}
        onDrop={(e) => colDrop(e, col)}
      >
        {ids.map((id, i) => (
          <Fragment key={id}>
            {hint && hint.col === col && hint.index === i && <div className="gdock-insert" />}
            {renderDockPanel(id, i < ids.length - 1)}
            {i < ids.length - 1 && (
              <div
                className="gsplit gsplit-h"
                title="拖拽调整上方面板高度"
                onPointerDown={(e) => {
                  const base = heightsRef.current[id] ?? DEFAULT_PANEL_H
                  startSplitDrag(e, 'y', (d) => setPanelH(id, base + d))
                }}
              />
            )}
          </Fragment>
        ))}
        {hint && hint.col === col && hint.index === ids.length && <div className="gdock-insert" />}
      </div>
    )
  }

  // 中央画布区（节点图 + 叠加层）：编辑布局与调试布局的「节点图」窗格共用（批次9）
  const graphCanvasArea = (
    <div
      className="graph-canvas"
      onContextMenu={(e) => {
        e.preventDefault()
      }}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={graphCardNodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => setSelectedId(n.id)}
        onPaneClick={() => {
          setSelectedId(null)
          setMenu(null)
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault()
          const flow = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
          setMenu({ screen: { x: e.clientX, y: e.clientY }, flow })
        }}
        onEdgeDoubleClick={(_, edge) => apply((prog) => disconnect(prog, edge.id))}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        minZoom={0.2}
        colorMode={theme}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.6} color="#26355a" />
        <MiniMap pannable zoomable nodeColor="#41598c" nodeStrokeColor="#6f86b8" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {showMap && (
        <CanvasMap
          comps={doc.content.components}
          views={doc.content.views}
          focusId={mapFocus}
          onToggleFocus={(id) => setMapFocus((cur) => (cur === id ? null : id))}
          onClose={() => {
            setShowMap(false)
            setMapFocus(null)
          }}
        />
      )}
      {menu && (
        <NodeContextMenu
          groups={palette}
          templates={templates}
          screen={menu.screen}
          onPick={(item) => addFromPalette(item, menu.flow)}
          onPickTemplate={(tpl) => addTemplate(tpl, menu.flow)}
          onClose={() => setMenu(null)}
        />
      )}
      {showScript && (
        <div className="graph-script-overlay">
          <div className="graph-script-head">
            <b>伪代码视图（LevelScript）</b>
            <span className="muted">只读——结构与图一一对应，双向无损</span>
            <button
              type="button"
              onClick={() => {
                setShowScript(false)
                setScriptError(null)
              }}
            >
              关闭
            </button>
          </div>
          {scriptError ? <div className="ginsp-issues tone-error">{scriptError}</div> : <pre className="script-view">{scriptText?.text}</pre>}
        </div>
      )}
    </div>
  )

  // 调试布局（批次9 可视化）：会话激活时整体替换编辑布局——
  // 左区 = 调试画面/节点图二选一（画面为默认），右侧 = 调试面板 + AI 助手列（宽度可拖拽）
  if (debugSnap.mode !== 'idle') {
    return (
      <div ref={rootRef} className={`graph-editor ge-${theme}${fullscreen ? ' is-fullscreen' : ''}`}>
        <div className="graph-toolbar">
          <span className="gdb-live" title="调试会话运行中——画面上的点击即真实事件，AI 的调试操作也实时可见">
            {debugSnap.mode === 'paused' ? `⏸ 调试中（暂停于 ${debugSnap.pausedAt}）` : '▶ 调试运行中'}
          </span>
          <button
            type="button"
            className="gtoggle"
            onClick={() => {
              stopDebugRun()
              setDbgPane('stage')
            }}
            title="结束调试会话并回到编辑布局"
          >
            ⏹ 停止调试
          </button>
          <button
            type="button"
            className={`gtoggle${dbgPane === 'stage' ? ' active' : ''}`}
            onClick={() => setDbgPane('stage')}
            title="左侧显示可交互的游玩画面"
          >
            ▶ 画面
          </button>
          <button
            type="button"
            className={`gtoggle${dbgPane === 'graph' ? ' active' : ''}`}
            onClick={() => setDbgPane('graph')}
            title="左侧显示节点图（断点圆点与暂停高亮）"
          >
            ⛏ 节点图
          </button>
          <span className="muted graph-toolbar-hint">变量/事件/断点/日志在右侧调试面板；AI 助手同列——AI 试玩全程可见</span>
        </div>
        {error && <div className="editor-errors">操作未生效：{error}</div>}
        <div className="graph-layout gdb-layout">
          <div className="gdb-main">{dbgPane === 'stage' ? <DebugStage doc={doc} /> : graphCanvasArea}</div>
          <div
            className="gsplit"
            title="拖拽调整右侧面板宽度（向左拖变宽）"
            onPointerDown={(e) => {
              const base = dbgRightW
              startSplitDrag(e, 'x', (d) => setDbgRightW(base - d))
            }}
          />
          <div className="graph-dock-col gdb-right" style={{ width: dbgRightW }}>
            <DockPanel icon="🐞" title="调试" style={{ flex: '0 0 auto', height: dbgDebugH }} onClose={stopDebugRun}>
              <DebugPanel doc={doc} onFocusNode={focusNode} />
            </DockPanel>
            <div
              className="gsplit gsplit-h"
              title="拖拽调整上方面板高度"
              onPointerDown={(e) => {
                const base = dbgDebugH
                startSplitDrag(e, 'y', (d) => setDbgDebugH(base + d))
              }}
            />
            <Suspense fallback={<aside className="ai-panel ai-panel-loading">AI 面板加载中…</aside>}>
              <AiPanel doc={doc} selection={{ tab: 'graph', nodeId: selectedId }} onClose={onToggleAi} onApplyDoc={onChange} style={{ flex: 1, minHeight: 0 }} />
            </Suspense>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} className={`graph-editor ge-${theme}${fullscreen ? ' is-fullscreen' : ''}`}>
      <div className="graph-toolbar">
        <button type="button" className={`gtoggle${panelVisible('library') ? ' active' : ''}`} onClick={() => togglePanel('library')} title="组件库面板（节点/模板菜单）">
          🧩 组件库
        </button>
        <button type="button" className={`gtoggle${panelVisible('events') ? ' active' : ''}`} onClick={() => togglePanel('events')} title="事件管理面板（系统/组件/内部事件 → 一键落节点）">
          ⚡ 事件
        </button>
        <button type="button" className={`gtoggle${panelVisible('vars') ? ' active' : ''}`} onClick={() => togglePanel('vars')} title="变量面板（声明/初值）">
          🧮 变量
        </button>
        <button type="button" className={`gtoggle${panelVisible('inspector') ? ' active' : ''}`} onClick={() => togglePanel('inspector')} title="节点属性面板">
          ⚙ 属性
        </button>
        <button type="button" className={`gtoggle${aiOpen ? ' active' : ''}`} onClick={onToggleAi} title="AI 助手面板（统一对话，随主题换肤）">
          🤖 AI
        </button>
        <button type="button" className={`gtoggle${panelVisible('debug') ? ' active' : ''}`} onClick={() => togglePanel('debug')} title="调试面板（断点/单步/变量观察与赋值/实时日志/手动触发事件；仅编辑器内可用）">
          🐞 调试
        </button>
        <span className="graph-tb-sep" aria-hidden />
        <button type="button" onClick={() => apply((prog) => arrangeLayout(prog, 'all'))} title="按执行层级自动重排全部节点">
          整理布局
        </button>
        <button
          type="button"
          onClick={() => apply((prog) => arrangeLayout(prog, 'missing'))}
          title="只给没有位置的节点补齐自动布局"
        >
          补齐新节点位置
        </button>
        <button type="button" className={showScript ? 'active' : ''} onClick={() => setShowScript((v) => !v)} title="以伪代码只读视图查看当前逻辑">
          查看脚本
        </button>
        <button type="button" className={showLog ? 'active' : ''} onClick={() => setShowLog((v) => !v)} title="查看最近一次试运行的逻辑错误与命令轨迹">
          运行日志{runLog.length > 0 ? `（${runLog.length}）` : ''}
        </button>
        <button
          type="button"
          className={showMap ? 'active' : ''}
          onClick={() => {
            if (showMap) setMapFocus(null) // 收起即解除高亮（评审 P2-6）
            setShowMap(!showMap)
          }}
          title="角落显示关卡画布缩略图，点击组件高亮相关节点"
        >
          画布对照
        </button>
        <button
          type="button"
          className={summaryMode === 'zh' ? 'active' : ''}
          title={summaryMode === 'zh' ? '节点摘要：中文模式（点击切回默认）' : '节点摘要：默认（点击切换为全中文）'}
          onClick={toggleSummary}
        >
          {summaryMode === 'zh' ? '中' : 'A'}
        </button>
        <button
          type="button"
          title={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? '☀ 浅色' : '🌙 深色'}
        </button>
        <button
          type="button"
          title="全屏运行工作台（Esc 退出）"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen()
            else void rootRef.current?.requestFullscreen()
          }}
        >
          ⛶ 全屏
        </button>
        <span className="muted graph-toolbar-hint">
          右键画布空白加节点 · 拖端口连线（真/假出口）· 双击连线断开 · Delete 删除选中节点
        </span>
        {lintIssues.length > 0 && (
          <button type="button" className="graph-lint-count" onClick={() => setShowIssues((v) => !v)} title="点击查看问题列表">
            ⚠ {lintIssues.length} 个问题
          </button>
        )}
      </div>
      {error && <div className="editor-errors">操作未生效：{error}</div>}
      {showIssues && lintIssues.length > 0 && (
        <div className="graph-issues">
          {lintIssues.map((issue, i) => (
            <button
              key={i}
              type="button"
              className="graph-issue"
              onClick={() => {
                if (issue.nodeId) focusNode(issue.nodeId)
                else if (issue.edgeId) {
                  const edge = program.edges.find((e) => e.id === issue.edgeId)
                  // 悬挂边优先定位起点；起点不存在（dangling 场景）回退终点
                  if (edge) focusNode(program.nodes.some((n) => n.id === edge.from) ? edge.from : edge.to)
                }
              }}
            >
              <span className="graph-issue-code">{issue.code}</span>
              <span>{issue.message}</span>
            </button>
          ))}
        </div>
      )}
      <div className="graph-layout">
        {visibleIn('left').length > 0 && renderDockCol('left')}
        {visibleIn('left').length > 0 && (
          <div
            className="gsplit"
            title="拖拽调整左栏宽度"
            onPointerDown={(e) => {
              const base = leftWRef.current
              startSplitDrag(e, 'x', (d) => setLeftW(base + d))
            }}
          />
        )}
        {graphCanvasArea}
        {(['rightA', 'rightB'] as ColKey[]).map((col) =>
          visibleIn(col).length === 0 ? null : (
            <Fragment key={col}>
              <div
                className="gsplit"
                title="拖拽调整该列宽度（向左拖变宽）"
                onPointerDown={(e) => {
                  const base = colWRefOf(col).current
                  startSplitDrag(e, 'x', (d) => colSetW(col, base - d))
                }}
              />
              {renderDockCol(col)}
            </Fragment>
          ),
        )}
      </div>
      {showLog && (
        <div className="graph-log">
          <div className="graph-log-head">
            <b>运行日志</b>
            <span className="muted">最近一次试运行（{errorCount} 个错误 / {runLog.length} 条）· 点击错误定位节点</span>
            <button
              type="button"
              onClick={() => {
                clearRunLog(doc.id)
                setLogTick((t) => t + 1)
              }}
            >
              清空
            </button>
            <button type="button" onClick={() => setLogTick((t) => t + 1)} title="试运行后刷新">
              刷新
            </button>
          </div>
          {runLog.length === 0 ? (
            <div className="muted graph-log-empty">暂无记录——点击「试运行」跑一遍关卡后再来看。</div>
          ) : (
            <div className="graph-log-list">
              {runLog.map((e, i) => (
                <button
                  key={i}
                  type="button"
                  className={`graph-log-entry ${e.kind}${e.nodeId ? ' has-node' : ''}`}
                  title={e.nodeId ? `定位节点 ${e.nodeId}` : undefined}
                  onClick={() => {
                    if (e.kind === 'error' && e.nodeId) focusNode(e.nodeId)
                  }}
                >
                  <span className={`graph-log-kind ${e.kind}`}>{e.kind === 'error' ? '错误' : '命令'}</span>
                  <span className="graph-log-msg">
                    {e.kind === 'command' ? (e.path ?? '') : (e.message ?? '')}
                    {e.kind === 'command' && e.detail && <span className="graph-log-detail">{e.detail}</span>}
                  </span>
                  {e.nodeId && <span className="graph-log-node">{e.nodeId}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function GraphEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphEditorInner {...props} />
    </ReactFlowProvider>
  )
}
export default GraphEditor
