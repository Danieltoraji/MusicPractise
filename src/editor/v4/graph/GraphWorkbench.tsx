/**
 * v4 通用图工作台（docs/53 §13.4；docs/52 W6.1）：Flow main 与 Behavior 两层共用同一编辑器。
 *
 * 关键机制：
 * - **受控单基线 apply**（docs/44 O9 同口径）：onNodesChange/onEdgesChange/检查器/调色板
 *   的所有编辑都经 `applyProgram(fn)`——基线取「已提交但尚未回流的 pending doc」，
 *   同一 task 内连续编辑不丢前一笔；写回走 docStateV4.updateFlow / updateBehavior，
 *   撤销 tag = 'flow' / 'behavior'（由 EditorPageV4.update 入栈合并）。
 * - React Flow 12：节点卡（kind+摘要）/ 端口协议（branch/loop/foreach 双出口，其余单出口）/
 *   选中与删除（window Delete，经 keyGuard 守卫）/ 拖拽落点写回 x/y / 连线校验中文报错。
 * - 停靠面板：左「调色板 + 变量」、右「属性」；面板显隐与列宽可调；右键画布空白弹调色板菜单。
 * - 伪代码视图：工作台内「图 / 伪代码」切换（复用 ScriptTabV4；同一文档层）。
 * - 主题：沿用 v3 `.graph-editor` 的 `--ui-*` 语义令牌与 `.ge-dark` 明暗切换（localStorage `graph-theme`），
 *   React Flow 颜色一律传 `var(--ui-*)`（G9 契约）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { BehaviorProgram, FlowProgram, LevelDocV4 } from '../../../engine/v4/model'
import { getType } from '../../../engine/v4/model'
import { lintLevelDocV4 } from '../../../engine/v4/lint'
import type { V4Issue } from '../../../engine/v4/validate'
import { allContracts } from '../../../runtime/store'
import { EDITOR_HOOKS } from '../../editorHooks'
import { deleteTargetBlocked } from '../../keyGuard'
import { updateBehavior, updateFlow } from '../docStateV4'
import type { V4EditorBehaviorSlotProps, V4EditorSlotProps } from '../shared'
import { ScriptTabV4 } from '../ScriptTabV4'
import { graphCardNodeTypes, type GraphCardNode } from './GraphCard'
import { NODE_H, NODE_W, missingPositions, nextNodePosition } from './layout'
import {
  buildBehaviorPalette,
  buildFlowPalette,
  type PaletteGroup,
  type PaletteItem,
} from './layerConfig'
import { NodeInspector } from './NodeInspector'
import {
  addNode,
  arrangeProgram,
  connectNodes,
  moveNode,
  newNodeId,
  portFromHandle,
  removeEdge,
  removeNode,
  updateNode,
  type AnyGraphNode,
  type GraphLayer,
} from './ops'
import { VariablesPanel } from './VariablesPanel'
import '../v4-graph.css'

type GraphTheme = 'dark' | 'light'
type GraphView = 'graph' | 'script'

const THEME_KEY = 'graph-theme'

const NO_POSITIONS = new Map<string, { x: number; y: number }>()

function programOf(doc: LevelDocV4, layer: GraphLayer, typeId: string | undefined): FlowProgram | BehaviorProgram | undefined {
  if (layer === 'flow') return doc.content.flow
  if (typeId === undefined) return undefined
  return getType(doc, typeId)?.behavior
}

/** 简单指针拖拽分隔条（真实浏览器 pointer 事件；jsdom 下不触发也不影响功能） */
function startSplitDrag(event: React.PointerEvent<HTMLDivElement>, axis: 'x' | 'y', onTotal: (delta: number) => void): void {
  event.preventDefault()
  try {
    event.currentTarget.setPointerCapture(event.pointerId)
  } catch {
    // jsdom 合成事件无 pointerId —— 忽略
  }
  const start = axis === 'x' ? event.clientX : event.clientY
  const onMove = (moveEvent: PointerEvent): void => {
    onTotal((axis === 'x' ? moveEvent.clientX : moveEvent.clientY) - start)
  }
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

// ---------------------------------------------------------------------------
// 插槽导出（EditorPageV4 → V4EditorShell 的 renderFlow / renderBehavior 接线点）
// ---------------------------------------------------------------------------

/** 流程 Tab 插槽：文档修改走 docStateV4.updateFlow（tag='flow'） */
export function FlowGraphSlot(props: V4EditorSlotProps): React.ReactNode {
  return <GraphWorkbench doc={props.doc} onChange={props.onChange} revision={props.revision} layer="flow" />
}

/** 题型「行为」子页插槽：文档修改走 docStateV4.updateBehavior（tag='behavior'） */
export function BehaviorGraphSlot(props: V4EditorBehaviorSlotProps): React.ReactNode {
  return (
    <GraphWorkbench
      doc={props.doc}
      onChange={props.onChange}
      revision={props.revision}
      layer="behavior"
      typeId={props.typeId}
    />
  )
}

export interface GraphWorkbenchProps extends V4EditorSlotProps {
  layer: GraphLayer
  /** behavior 层必填：题型 id（决定 surface 事件候选与 updateBehavior 目标） */
  typeId?: string
}

export function GraphWorkbench(props: GraphWorkbenchProps): React.ReactElement {
  return (
    <ReactFlowProvider>
      <GraphWorkbenchInner {...props} />
    </ReactFlowProvider>
  )
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

function GraphWorkbenchInner(props: GraphWorkbenchProps): React.ReactElement {
  const { doc, onChange, layer, typeId } = props
  const rf = useReactFlow()
  const program = programOf(doc, layer, typeId)

  // ------- 视图/面板/主题状态 -------
  const [theme, setTheme] = useState<GraphTheme>(() => (localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'))
  const [view, setView] = useState<GraphView>('graph')
  const [showPalette, setShowPalette] = useState(true)
  const [showVars, setShowVars] = useState(true)
  const [showInspector, setShowInspector] = useState(true)
  const [leftW, setLeftW] = useState(220)
  const [rightW, setRightW] = useState(320)
  const leftWRef = useRef(leftW)
  leftWRef.current = leftW
  const rightWRef = useRef(rightW)
  rightWRef.current = rightW

  const toggleTheme = (): void => {
    setTheme((current) => {
      const next: GraphTheme = current === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(THEME_KEY, next)
      } catch {
        // 布局/主题持久化降级：不影响本会话
      }
      return next
    })
  }

  // ------- 受控单基线 apply（O9 契约） -------
  const docRef = useRef(doc)
  docRef.current = doc
  const pendingDocRef = useRef<LevelDocV4 | null>(null)
  useEffect(() => {
    pendingDocRef.current = null
  }, [doc])

  const [error, setError] = useState<string | null>(null)
  const apply = useCallback(
    (fn: (base: LevelDocV4) => LevelDocV4): boolean => {
      try {
        const base = pendingDocRef.current ?? docRef.current
        const next = fn(base)
        setError(null)
        if (next !== base) {
          pendingDocRef.current = next
          onChange(next, layer)
        }
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
    },
    [onChange, layer],
  )
  const applyProgram = useCallback(
    (fn: (program: FlowProgram | BehaviorProgram) => FlowProgram | BehaviorProgram): boolean => {
      return apply((base) => {
        if (layer === 'flow') return updateFlow(base, (flow) => fn(flow) as FlowProgram)
        if (typeId === undefined) throw new Error('行为图缺少题型 id（typeId），无法写回文档')
        return updateBehavior(base, typeId, (behavior) => fn(behavior) as BehaviorProgram)
      })
    },
    [apply, layer, typeId],
  )

  // ------- lint / 契约 -------
  const contracts = useMemo(() => new Map(allContracts().map((contract) => [contract.type, contract])), [])
  const contractOf = useCallback(
    (componentType: string) => {
      const contract = contracts.get(componentType)
      return contract !== undefined
        ? { events: contract.events, commands: contract.commands, queries: contract.queries }
        : undefined
    },
    [contracts],
  )
  const lintIssues = useMemo(() => lintLevelDocV4(doc, { contractOf }), [doc, contractOf])
  const nodeIdSet = useMemo(() => new Set((program?.nodes ?? []).map((node) => node.id)), [program])
  const layerIssues = useMemo<V4Issue[]>(() => {
    return lintIssues.filter((issue) => {
      if (issue.nodeId === undefined || !nodeIdSet.has(issue.nodeId)) return false
      if (layer === 'behavior') return issue.typeId === typeId
      return issue.typeId === undefined
    })
  }, [lintIssues, nodeIdSet, layer, typeId])
  const issuesByNode = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const issue of layerIssues) {
      if (issue.nodeId === undefined) continue
      const list = map.get(issue.nodeId) ?? []
      list.push(issue.message)
      map.set(issue.nodeId, list)
    }
    return map
  }, [layerIssues])

  // ------- 画布：节点/边/选区/拖动 -------
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rfSel, setRfSel] = useState<{ nodes: Set<string>; edges: Set<string> }>(() => ({
    nodes: new Set<string>(),
    edges: new Set<string>(),
  }))
  const rfSelRef = useRef(rfSel)
  rfSelRef.current = rfSel
  const [dragPos, setDragPos] = useState<Map<string, { x: number; y: number }>>(() => NO_POSITIONS)
  const [menu, setMenu] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null)
  const [showIssues, setShowIssues] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const fallbackPos = useMemo(() => (program !== undefined ? missingPositions(program) : NO_POSITIONS), [program])

  // 节点对象缓存：dimensions 变更合并进缓存（RF 受控模式需要 measured，否则拖拽会报尺寸缺失错误）
  const nodeCacheRef = useRef<{ map: Map<string, GraphCardNode>; sig: Map<string, string> }>({
    map: new Map(),
    sig: new Map(),
  })
  const nodeJsonCache = useRef(new WeakMap<object, string>())
  const nodeJson = (node: AnyGraphNode): string => {
    const cached = nodeJsonCache.current.get(node)
    if (cached !== undefined) return cached
    const text = JSON.stringify(node)
    nodeJsonCache.current.set(node, text)
    return text
  }
  const rfNodes = useMemo<GraphCardNode[]>(() => {
    const { map: previousMap, sig: previousSig } = nodeCacheRef.current
    const nextMap = new Map<string, GraphCardNode>()
    const nextSig = new Map<string, string>()
    const nodes = (program?.nodes ?? []).map((node): GraphCardNode => {
      const drag = dragPos.get(node.id)
      const base =
        drag ?? (node.x !== undefined && node.y !== undefined ? { x: node.x, y: node.y } : fallbackPos.get(node.id))
      const position = { x: base?.x ?? 0, y: base?.y ?? 0 }
      const errors = issuesByNode.get(node.id)
      const selected = rfSel.nodes.has(node.id)
      const signature = `${nodeJson(node)}|${JSON.stringify(errors ?? [])}|${position.x},${position.y}|${drag ? 'drag' : 'doc'}|${selected ? 's' : ''}`
      const previous = previousMap.get(node.id)
      if (previous !== undefined && previousSig.get(node.id) === signature) {
        nextMap.set(node.id, previous)
        nextSig.set(node.id, signature)
        return previous
      }
      const created: GraphCardNode = {
        id: node.id,
        type: 'graphCard',
        position,
        data: { node, errors },
        width: NODE_W,
        height: NODE_H,
        measured: { width: NODE_W, height: NODE_H },
        selected,
      }
      nextMap.set(node.id, created)
      nextSig.set(node.id, signature)
      return created
    })
    nodeCacheRef.current = { map: nextMap, sig: nextSig }
    return nodes
  }, [program, fallbackPos, dragPos, issuesByNode, rfSel.nodes])

  const rfEdges = useMemo<Edge[]>(
    () =>
      (program?.edges ?? []).map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        sourceHandle: edge.port ?? 'out',
        targetHandle: 'in',
        selected: rfSel.edges.has(edge.id),
        className: edge.port !== undefined ? `gedge gedge-${edge.port}` : 'gedge',
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [program, rfSel.edges],
  )

  // 外部改写文档（撤销/脚本应用/JSON）后清理悬空选区
  const programNodeIds = useMemo(() => new Set((program?.nodes ?? []).map((node) => node.id)), [program])
  const programEdgeIds = useMemo(() => new Set((program?.edges ?? []).map((edge) => edge.id)), [program])
  useEffect(() => {
    setSelectedId((current) => (current !== null && !programNodeIds.has(current) ? null : current))
    setRfSel((current) => {
      const nodes = [...current.nodes].filter((id) => programNodeIds.has(id))
      const edges = [...current.edges].filter((id) => programEdgeIds.has(id))
      if (nodes.length === current.nodes.size && edges.length === current.edges.size) return current
      return { nodes: new Set(nodes), edges: new Set(edges) }
    })
  }, [programNodeIds, programEdgeIds])

  const onNodesChange = useCallback(
    (changes: NodeChange<GraphCardNode>[]): void => {
      const selects = changes.filter((change) => change.type === 'select')
      if (selects.length > 0) {
        setRfSel((current) => {
          const nodes = new Set(current.nodes)
          for (const change of selects) {
            if (change.type !== 'select') continue
            if (change.selected) nodes.add(change.id)
            else nodes.delete(change.id)
          }
          return { ...current, nodes }
        })
      }
      const dragging = changes.filter((change) => change.type === 'position' && change.dragging === true && change.position)
      if (dragging.length > 0) {
        setDragPos((current) => {
          const next = new Map(current)
          for (const change of dragging) {
            if (change.type === 'position' && change.position) next.set(change.id, { x: change.position.x, y: change.position.y })
          }
          return next
        })
      }
      // RF DOM 测量回传：合并进缓存节点（视图态，不落 IR）
      for (const change of changes) {
        if (change.type !== 'dimensions') continue
        const cached = nodeCacheRef.current.map.get(change.id)
        if (cached !== undefined) {
          cached.measured = { width: change.dimensions?.width ?? NODE_W, height: change.dimensions?.height ?? NODE_H }
        }
      }
      const settle = changes.filter((change) => (change.type === 'position' && change.dragging === false) || change.type === 'remove')
      if (settle.length === 0) return
      applyProgram((current) => {
        let next = current
        for (const change of settle) {
          if (change.type === 'position' && change.position) {
            next = moveNode(next, change.id, change.position.x, change.position.y)
          } else if (change.type === 'remove') {
            next = removeNode(next, change.id)
          }
        }
        return next
      })
      setDragPos(NO_POSITIONS)
      const removedIds = settle.filter((change) => change.type === 'remove').map((change) => change.id)
      if (removedIds.length > 0) {
        setSelectedId((current) => (current !== null && removedIds.includes(current) ? null : current))
        setRfSel((current) => {
          const nodes = new Set(current.nodes)
          for (const id of removedIds) nodes.delete(id)
          return { ...current, nodes }
        })
      }
    },
    [applyProgram],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]): void => {
      const selects = changes.filter((change) => change.type === 'select')
      if (selects.length > 0) {
        setRfSel((current) => {
          const edges = new Set(current.edges)
          for (const change of selects) {
            if (change.type !== 'select') continue
            if (change.selected) edges.add(change.id)
            else edges.delete(change.id)
          }
          return { ...current, edges }
        })
      }
      const removed = changes.filter((change) => change.type === 'remove')
      if (removed.length === 0) return
      applyProgram((current) => {
        let next = current
        for (const change of removed) next = removeEdge(next, change.id)
        return next
      })
      setRfSel((current) => {
        const edges = new Set(current.edges)
        for (const change of removed) edges.delete(change.id)
        return { ...current, edges }
      })
    },
    [applyProgram],
  )

  const onConnect = useCallback(
    (connection: Connection): void => {
      applyProgram((current) => connectNodes(current, connection.source, connection.target, portFromHandle(connection.sourceHandle)))
    },
    [applyProgram],
  )

  // 删除键：只走自有 window 监听（RF 内建删除通道关闭，避免双路径；经 keyGuard 守卫）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (deleteTargetBlocked(event.target)) return
      const nodeIds = [...rfSelRef.current.nodes]
      const edgeIds = [...rfSelRef.current.edges]
      if (nodeIds.length === 0 && edgeIds.length === 0) return
      event.preventDefault()
      applyProgram((current) => {
        let next = current
        for (const id of edgeIds) next = removeEdge(next, id)
        for (const id of nodeIds) next = removeNode(next, id)
        return next
      })
      setRfSel({ nodes: new Set<string>(), edges: new Set<string>() })
      setSelectedId((current) => (current !== null && nodeIds.includes(current) ? null : current))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyProgram])

  const focusNode = useCallback(
    (id: string): void => {
      setSelectedId(id)
      setRfSel({ nodes: new Set([id]), edges: new Set() })
      const node = program?.nodes.find((candidate) => candidate.id === id)
      const base =
        node?.x !== undefined && node?.y !== undefined ? { x: node.x, y: node.y } : fallbackPos.get(id)
      if (base !== undefined) {
        try {
          rf.setCenter(base.x + NODE_W / 2, base.y + NODE_H / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 300 })
        } catch {
          // RF 未挂载（脚本视图切换瞬间）：定位降级为仅选中
        }
      }
    },
    [program, fallbackPos, rf],
  )

  // ------- 调色板 -------
  const paletteGroups: PaletteGroup[] = useMemo(() => {
    if (program === undefined) return []
    return layer === 'flow'
      ? buildFlowPalette(doc, program as FlowProgram)
      : buildBehaviorPalette(doc, typeId, program as BehaviorProgram)
  }, [doc, layer, program, typeId])

  const addFromPalette = useCallback(
    (item: PaletteItem, position?: { x: number; y: number }): void => {
      const pos = position ?? (program !== undefined ? nextNodePosition(program) : { x: 60, y: 60 })
      applyProgram((current) => {
        const shape = item.make()
        const id = newNodeId(shape.kind, current.nodes.map((node) => node.id))
        return addNode(current, { ...item.make(pos), id } as AnyGraphNode)
      })
    },
    [applyProgram, program],
  )

  const selectedNode = program?.nodes.find((node) => node.id === selectedId)
  const selectedIssues = selectedId !== null ? layerIssues.filter((issue) => issue.nodeId === selectedId) : []

  // 钩子全部就位后再做「层不存在」早退（React Hooks 纪律：不得在条件早退后调 Hook）
  if (program === undefined) {
    return (
      <div className="graph-editor v4-graph-workbench ge-dark" data-testid="v4-graph-workbench" data-layer={layer}>
        <div className="editor-errors" data-testid="v4-graph-error">
          {layer === 'behavior' ? `题型「${typeId ?? ''}」不存在，无法编辑行为图` : '文档缺少主流程（flow）'}
        </div>
      </div>
    )
  }

  const title = layer === 'flow' ? '流程 main' : `行为 · ${typeId}`
  const renderingGraph = view === 'graph'

  return (
    <div
      ref={rootRef}
      className={`graph-editor v4-graph-workbench ge-${theme}`}
      data-testid="v4-graph-workbench"
      data-layer={layer}
      data-view={view}
    >
      <div className="graph-toolbar">
        <button
          type="button"
          data-testid="v4-graph-view-graph"
          className={`${EDITOR_HOOKS.graphToggle}${renderingGraph ? ' active' : ''}`}
          onClick={() => setView('graph')}
          title="节点图视图"
        >
          ⛏ 节点图
        </button>
        <button
          type="button"
          data-testid="v4-graph-view-script"
          className={`${EDITOR_HOOKS.graphToggle}${renderingGraph ? '' : ' active'}`}
          onClick={() => setView('script')}
          title="伪代码视图（图 IR 的文本投影，可编辑并应用）"
        >
          📝 伪代码
        </button>
        <span className="graph-tb-sep" aria-hidden />
        <button
          type="button"
          data-testid="v4-graph-toggle-palette"
          className={`${EDITOR_HOOKS.graphToggle}${showPalette ? ' active' : ''}`}
          onClick={() => setShowPalette((value) => !value)}
          title="调色板（添加节点）"
        >
          🧩 调色板
        </button>
        <button
          type="button"
          data-testid="v4-graph-toggle-vars"
          className={`${EDITOR_HOOKS.graphToggle}${showVars ? ' active' : ''}`}
          onClick={() => setShowVars((value) => !value)}
          title={layer === 'flow' ? 'run 变量声明（v.*）' : '调用局部变量（local.*）'}
        >
          🧮 变量
        </button>
        <button
          type="button"
          data-testid="v4-graph-toggle-inspector"
          className={`${EDITOR_HOOKS.graphToggle}${showInspector ? ' active' : ''}`}
          onClick={() => setShowInspector((value) => !value)}
          title="节点属性检查器"
        >
          ⚙ 属性
        </button>
        <span className="graph-tb-sep" aria-hidden />
        <button
          type="button"
          data-testid="v4-graph-arrange"
          onClick={() => applyProgram((current) => arrangeProgram(current, 'all'))}
          title="按执行层级自动重排全部节点（写回 x/y）"
        >
          整理布局
        </button>
        <button
          type="button"
          data-testid="v4-graph-theme"
          title={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? '☀ 浅色' : '🌙 深色'}
        </button>
        <span className="muted graph-toolbar-hint">
          {title} · 右键画布空白加节点 · 拖端口连线（真/假出口）· 双击连线断开 · Delete 删除选中节点/连线
        </span>
        {layerIssues.length > 0 && (
          <button
            type="button"
            className="graph-lint-count"
            data-testid="v4-graph-lint-toggle"
            onClick={() => setShowIssues((value) => !value)}
            title="点击查看当前层的问题列表"
          >
            ⚠ {layerIssues.length} 个问题
          </button>
        )}
      </div>

      {error !== null && (
        <div className="editor-errors" data-testid="v4-graph-error">
          操作未生效：{error}
        </div>
      )}

      {view === 'script' ? (
        <ScriptTabV4 doc={doc} onChange={onChange} revision={props.revision} layer={layer} typeId={typeId} />
      ) : (
        <>
          {showIssues && layerIssues.length > 0 && (
            <div className="graph-issues" data-testid="v4-graph-issues">
              {layerIssues.map((issue, index) => (
                <button
                  key={index}
                  type="button"
                  className="graph-issue"
                  onClick={() => {
                    if (issue.nodeId !== undefined) focusNode(issue.nodeId)
                  }}
                >
                  <span className="graph-issue-code">{issue.code}</span>
                  <span>{issue.message}</span>
                </button>
              ))}
            </div>
          )}
          <div className="graph-layout v4-graph-layout">
            {(showPalette || showVars) && (
              <div className="graph-dock-col v4-graph-dock-left" style={{ width: leftW }} data-testid="v4-graph-dock-left">
                {showPalette && (
                  <section className="gdock" data-testid="v4-graph-palette">
                    <header className="gdock-head">
                      <span className="gdock-title">🧩 调色板</span>
                      <button type="button" className="gdock-close" title="收起到工具栏" onClick={() => setShowPalette(false)}>
                        ✕
                      </button>
                    </header>
                    <div className="gdock-body">
                      <PaletteList groups={paletteGroups} onPick={(item) => addFromPalette(item)} />
                    </div>
                  </section>
                )}
                {showVars && (
                  <section className="gdock" data-testid="v4-graph-vars-panel">
                    <header className="gdock-head">
                      <span className="gdock-title">🧮 变量</span>
                      <button type="button" className="gdock-close" title="收起到工具栏" onClick={() => setShowVars(false)}>
                        ✕
                      </button>
                    </header>
                    <div className="gdock-body">
                      <VariablesPanel
                        layer={layer}
                        doc={doc}
                        typeId={typeId}
                        program={program}
                        onChangeProgram={(fn) => applyProgram(fn)}
                      />
                    </div>
                  </section>
                )}
              </div>
            )}
            {(showPalette || showVars) && (
              <div
                className="gsplit"
                title="拖拽调整左栏宽度"
                onPointerDown={(event) => {
                  const base = leftWRef.current
                  startSplitDrag(event, 'x', (delta) => setLeftW(Math.min(420, Math.max(160, base + delta))))
                }}
              />
            )}

            <div
              className="graph-canvas v4-graph-canvas"
              data-testid="v4-graph-canvas"
              onContextMenu={(event) => event.preventDefault()}
            >
              <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={graphCardNodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, node) => setSelectedId(node.id)}
                onPaneClick={() => {
                  setSelectedId(null)
                  setMenu(null)
                }}
                onPaneContextMenu={(event) => {
                  event.preventDefault()
                  try {
                    const flow = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY })
                    setMenu({ screen: { x: event.clientX, y: event.clientY }, flow })
                  } catch {
                    setMenu({ screen: { x: event.clientX, y: event.clientY }, flow: { x: 60, y: 60 } })
                  }
                }}
                onEdgeDoubleClick={(_, edge) => {
                  applyProgram((current) => removeEdge(current, edge.id))
                }}
                deleteKeyCode={null}
                fitView
                minZoom={0.2}
                colorMode={theme}
              >
                <Background variant={BackgroundVariant.Dots} gap={26} size={1.6} color="var(--ui-line)" />
                <MiniMap pannable zoomable nodeColor="var(--ui-node-line)" nodeStrokeColor="var(--ui-edge)" />
                <Controls showInteractive={false} />
              </ReactFlow>
              {menu !== null && (
                <PaletteMenu
                  groups={paletteGroups}
                  screen={menu.screen}
                  onPick={(item) => addFromPalette(item, menu.flow)}
                  onClose={() => setMenu(null)}
                />
              )}
            </div>

            {showInspector && (
              <>
                <div
                  className="gsplit"
                  title="拖拽调整右栏宽度（向左拖变宽）"
                  onPointerDown={(event) => {
                    const base = rightWRef.current
                    startSplitDrag(event, 'x', (delta) => setRightW(Math.min(480, Math.max(240, base - delta))))
                  }}
                />
                <div
                  className="graph-dock-col v4-graph-dock-right"
                  style={{ width: rightW }}
                  data-testid="v4-graph-dock-right"
                >
                  <section className="gdock">
                    <header className="gdock-head">
                      <span className="gdock-title">⚙ 属性</span>
                      <button type="button" className="gdock-close" title="收起到工具栏" onClick={() => setShowInspector(false)}>
                        ✕
                      </button>
                    </header>
                    <div className="gdock-body">
                      <NodeInspector
                        layer={layer}
                        doc={doc}
                        typeId={typeId}
                        program={program}
                        node={selectedNode}
                        issues={selectedIssues}
                        onPatch={(patch) => {
                          if (selectedId === null) return
                          applyProgram((current) => updateNode(current, selectedId, patch))
                        }}
                        onRemove={() => {
                          if (selectedId === null) return
                          const id = selectedId
                          applyProgram((current) => removeNode(current, id))
                          setSelectedId(null)
                          setRfSel((current) => {
                            const nodes = new Set(current.nodes)
                            nodes.delete(id)
                            return { ...current, nodes }
                          })
                        }}
                      />
                    </div>
                  </section>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 调色板面板 / 右键菜单（同源数据）
// ---------------------------------------------------------------------------

function PaletteList(props: { groups: PaletteGroup[]; onPick: (item: PaletteItem) => void }): React.ReactElement {
  const [filter, setFilter] = useState('')
  const keyword = filter.trim()
  return (
    <div className="glib v4-graph-palette">
      <input
        className="gmenu-filter"
        placeholder="搜索节点…"
        data-testid="v4-graph-palette-filter"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {props.groups.map((group) => {
        const items = keyword === '' ? group.items : group.items.filter((item) => `${group.label} ${item.label} ${item.desc}`.includes(keyword))
        if (items.length === 0) return null
        return (
          <div key={group.id} className="glib-group" data-testid={`palette-group-${group.id}`}>
            <div className="glib-group-head" title={group.hint}>
              {group.label}
            </div>
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                className="glib-item"
                data-testid={`palette-item-${item.key}`}
                title={item.desc}
                onClick={() => props.onPick(item)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function PaletteMenu(props: {
  groups: PaletteGroup[]
  screen: { x: number; y: number }
  onPick: (item: PaletteItem) => void
  onClose: () => void
}): React.ReactElement {
  const [filter, setFilter] = useState('')
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [props])
  const keyword = filter.trim()
  // 屏幕边缘钳制：菜单宽约 250、高约 420
  const left = Math.min(props.screen.x, Math.max(8, window.innerWidth - 262))
  const top = Math.min(props.screen.y, Math.max(8, window.innerHeight - 432))
  return (
    <div className="gmenu-backdrop" onMouseDown={props.onClose} onContextMenu={(event) => event.preventDefault()}>
      <div className="gmenu" style={{ left, top }} onMouseDown={(event) => event.stopPropagation()} data-testid="v4-graph-palette-menu">
        <input
          className="gmenu-filter"
          placeholder="搜索节点…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          autoFocus
        />
        {props.groups.map((group) => {
          const items = keyword === '' ? group.items : group.items.filter((item) => `${group.label} ${item.label} ${item.desc}`.includes(keyword))
          if (items.length === 0) return null
          return (
            <div key={group.id} className="glib-group">
              <div className="glib-group-head">{group.label}</div>
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="glib-item"
                  data-testid={`palette-menu-item-${item.key}`}
                  title={item.desc}
                  onClick={() => {
                    props.onPick(item)
                    props.onClose()
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
