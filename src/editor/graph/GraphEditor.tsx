/**
 * 节点图编辑器（3-2a）：三栏布局 + React Flow 画布。
 * doc.content.logic（GraphProgram v2）唯一真源；一切编辑 = graphOps 纯函数 → onChange 回写 doc，
 * 非法操作（on 入边、端口缺失等）由 ops 抛错 → 错误条提示、doc 不变（受控画布自动回滚）。
 * 默认导出（React.lazy 懒加载 @xyflow/react，不进主包）。
 */
import { useCallback, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
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
  removeNode,
  updateNode,
  type GraphProgram,
} from '../../engine/graphProgram'
import { buildPalette } from './palette'
import { NODE_H, NODE_W, arrangeLayout, dagrePositions } from './layout'
import { graphCardNodeTypes, type GraphCardData } from './nodeTypes'
import { NodeContextMenu, NodeLibraryPanel } from './NodeLibrary'
import { NodeInspector } from './NodeInspector'

interface Props {
  doc: LevelDoc
  onChange: (doc: LevelDoc) => void
}

function GraphEditorInner({ doc, onChange }: Props) {
  const program = doc.content.logic
  const rf = useReactFlow()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null)

  const palette = useMemo(() => buildPalette(doc), [doc])
  const lintIssues = useMemo(
    () =>
      lintGraphProgramDetailed(program, {
        componentIds: doc.content.components.map((c) => c.id),
        extraVariableKeys: doc.content.questions.flatMap((q) => Object.keys(q.logicPatch?.variables ?? {})),
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

  /** graphOps 变换 → 回写 doc；抛错转错误条（画布受控回滚） */
  const apply = useCallback(
    (fn: (prog: GraphProgram) => GraphProgram): void => {
      try {
        const logic = fn(doc.content.logic)
        setError(null)
        if (logic !== doc.content.logic) onChange({ ...doc, content: { ...doc.content, logic } })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [doc, onChange],
  )

  // 无 x/y 的节点（迁移产物）用 dagre 兜底定位，仅视图层；拖动或整理布局时才写回
  const fallbackPos = useMemo(() => dagrePositions(program), [program])

  const rfNodes: Node<GraphCardData>[] = useMemo(
    () =>
      program.nodes.map((node) => {
        const p = node.x !== undefined && node.y !== undefined ? node : fallbackPos.get(node.id)
        return {
          id: node.id,
          type: 'graphCard',
          position: { x: p?.x ?? 0, y: p?.y ?? 0 },
          data: { node, errors: issuesByNode.get(node.id) },
          width: NODE_W,
          height: NODE_H,
        }
      }),
    [program, fallbackPos, issuesByNode],
  )
  const rfEdges: Edge[] = useMemo(
    () =>
      program.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle: e.port ?? 'out',
        targetHandle: 'in',
        className: e.port ? `gedge gedge-${e.port}` : 'gedge',
        markerEnd: 'edge-closed',
      })),
    [program.edges],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<GraphCardData>>[]): void => {
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false && change.position) {
          apply((prog) => moveNode(prog, change.id, change.position!.x, change.position!.y))
        } else if (change.type === 'remove') {
          apply((prog) => removeNode(prog, change.id))
          setSelectedId((cur) => (cur === change.id ? null : cur))
        }
      }
    },
    [apply],
  )

  const onConnect = useCallback(
    (params: { source: string; target: string; sourceHandle: string | null }): void => {
      const port = params.sourceHandle === 'true' || params.sourceHandle === 'false' ? params.sourceHandle : undefined
      apply((prog) => connect(prog, params.source, params.target, port))
    },
    [apply],
  )

  const addFromPalette = useCallback(
    (item: (typeof palette)[number]['items'][number], pos?: { x: number; y: number }): void => {
      apply((prog) => addNode(prog, { ...item.make(pos), id: newNodeId(prog) } as GNode))
    },
    [apply],
  )

  const selected = selectedId ? program.nodes.find((n) => n.id === selectedId) : undefined
  const selectedIssues = selectedId ? lintIssues.filter((i) => i.nodeId === selectedId) : []

  return (
    <div className="graph-editor">
      <div className="graph-toolbar">
        <button
          type="button"
          onClick={() => apply((prog) => arrangeLayout(prog, 'all'))}
          title="按执行层级自动重排全部节点"
        >
          整理布局
        </button>
        <button
          type="button"
          onClick={() => apply((prog) => arrangeLayout(prog, 'missing'))}
          title="只给没有位置的节点补齐自动布局"
        >
          补齐新节点位置
        </button>
        <span className="muted graph-toolbar-hint">
          右键画布空白加节点 · 拖端口连线（真/假出口）· 双击连线断开 · Delete 删除选中
        </span>
        {lintIssues.length > 0 && <span className="graph-lint-count">⚠ {lintIssues.length} 个问题</span>}
      </div>
      {error && <div className="editor-errors">操作未生效：{error}</div>}
      <div className="graph-layout">
        <NodeLibraryPanel groups={palette} onPick={(item) => addFromPalette(item)} />
        <div
          className="graph-canvas"
          onContextMenu={(e) => {
            // 画布空白右键（React Flow onPaneContextMenu 在 pane 上触发，这里兜底容器空白）
            e.preventDefault()
          }}
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={graphCardNodeTypes}
            onNodesChange={onNodesChange}
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
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <MiniMap pannable zoomable />
            <Controls showInteractive={false} />
          </ReactFlow>
          {menu && (
            <NodeContextMenu
              groups={palette}
              screen={menu.screen}
              onPick={(item) => addFromPalette(item, menu.flow)}
              onClose={() => setMenu(null)}
            />
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
