/**
 * 节点图编辑器：三栏布局 + React Flow 画布 + 体验面板（运行日志/lint 列表/变量/查看脚本）。
 * doc.content.logic（GraphProgram v2）唯一真源；一切编辑 = graphOps 纯函数 → onChange 回写 doc，
 * 非法操作（on 入边、端口缺失等）由 ops 抛错 → 错误条提示、doc 不变（受控画布自动回滚）。
 * 拖动跟手：拖动中间帧走 transient 状态（不进 doc），落点一次性 moveNode 持久化。
 * 默认导出（React.lazy 懒加载 @xyflow/react，不进主包）。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
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
import { graphCardNodeTypes, type GraphCardData } from './nodeTypes'
import { NodeContextMenu, NodeLibraryPanel } from './NodeLibrary'
import { NodeInspector } from './NodeInspector'
import { VariablesPanel } from './VariablesPanel'
import { CanvasMap } from './CanvasMap'
import { clearRunLog, readRunLog } from '../../runtime/runLog'

interface Props {
  doc: LevelDoc
  onChange: (doc: LevelDoc) => void
}

const NO_POSITIONS = new Map<string, { x: number; y: number }>()

function GraphEditorInner({ doc, onChange }: Props) {
  const program = doc.content.logic
  const rf = useReactFlow()
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
        viewIds: doc.content.views.map((v) => v.id),
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
      const signature = `${JSON.stringify(node)}|${JSON.stringify(errors ?? [])}|${position.x},${position.y}|${drag ? 'drag' : 'doc'}|${related ? 'r' : ''}|${compsSig}`
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
        data: { node, errors, comps: compsInfo, related },
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
  }, [program, fallbackPos, issuesByNode, dragPos, compsInfo, compsSig, relatedIds])

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

  return (
    <div className="graph-editor">
      <div className="graph-toolbar">
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
          title="全屏运行工作台（Esc 退出）"
          onClick={() => {
            const el = document.querySelector('.graph-editor')
            if (document.fullscreenElement) void document.exitFullscreen()
            else void el?.requestFullscreen()
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
        <div className="graph-left">
          <NodeLibraryPanel
            groups={palette}
            templates={templates}
            onPick={(item) => addFromPalette(item)}
            onPickTemplate={(tpl) => addTemplate(tpl)}
          />
          <VariablesPanel
            prog={program}
            onSet={(name, value) => apply((prog) => setGraphVariable(prog, name, value))}
            onRename={(oldName, newName) => apply((prog) => renameGraphVariable(prog, oldName, newName))}
            onRemove={(name) => apply((prog) => removeGraphVariable(prog, name))}
          />
        </div>
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
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
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
                  <span className="graph-log-msg">{e.kind === 'command' ? (e.path ?? '') : (e.message ?? '')}</span>
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
