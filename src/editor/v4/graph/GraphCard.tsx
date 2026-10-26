/**
 * v4 图节点卡（React Flow 自定义节点）。端口协议按 docs/53 §6/§7：
 * - branch / loop / foreach：右侧 true（绿，体/真）+ false（红，出口/假）双出口；
 * - 其余可执行节点：右侧单出口（handle id 'out'，IR 边无 port）；
 * - start / on：无入边；return / restart：无出边；comment：完全不可接线（不参与执行）。
 *
 * 视觉复用 v3 `.gnode*` / `.gport-*` / `.gedge-*` 类（index.css 已定义），
 * v4 只在 `v4-graph.css` 里补 kind 色带（全部 `--ui-*` 令牌，无裸色）。
 */
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { AnyGraphNode } from './ops'
import { canAcceptInput, hasOutput, isDualPortKind } from './ops'
import { nodeKindLabel, summarizeNode } from './summary'

export interface GraphCardData extends Record<string, unknown> {
  node: AnyGraphNode
  /** 该节点的 lint 消息（红框 + ⚠ + title） */
  errors?: string[]
  /** 调试/外部定位高亮（保留给 W7 调试面板） */
  related?: boolean
}

export type GraphCardNode = Node<GraphCardData, 'graphCard'>

function GraphCard({ data, selected }: NodeProps<GraphCardNode>): React.ReactElement {
  const node = data.node
  const errors = data.errors ?? []
  const dual = isDualPortKind(node.kind)
  const acceptInput = canAcceptInput(node.kind)
  const output = hasOutput(node.kind)
  return (
    <div
      className={`gnode v4-gnode v4-gnode-${node.kind}${selected ? ' is-selected' : ''}${errors.length > 0 ? ' has-error' : ''}${data.related === true ? ' is-related' : ''}`}
      data-testid={`graph-card-${node.id}`}
      data-node-kind={node.kind}
      title={errors.length > 0 ? errors.join('\n') : summarizeNode(node).join('\n')}
    >
      <div className={`gnode-band v4-gnode-band-${node.kind}`} />
      <div className="gnode-head">
        <span className="gnode-kind">{nodeKindLabel(node)}</span>
        {errors.length > 0 && (
          <span className="gnode-badge" title={errors.join('\n')}>
            ⚠
          </span>
        )}
      </div>
      <div className="gnode-body">
        {summarizeNode(node).map((line, index) => (
          <div key={index} className="gnode-line" title={line}>
            {line}
          </div>
        ))}
      </div>
      {acceptInput && <Handle type="target" position={Position.Left} id="in" isConnectable />}
      {dual && output ? (
        <>
          <Handle type="source" position={Position.Right} id="true" className="gport-true" style={{ top: 14 }} isConnectable />
          <Handle type="source" position={Position.Right} id="false" className="gport-false" style={{ top: 'calc(100% - 14px)' }} isConnectable />
          <span className="gport-label" style={{ top: 6 }}>
            真
          </span>
          <span className="gport-label" style={{ bottom: 6 }}>
            假
          </span>
        </>
      ) : output ? (
        <Handle type="source" position={Position.Right} id="out" isConnectable />
      ) : null}
    </div>
  )
}

/** 模块级稳定注册（React Flow 要求 nodeTypes 引用稳定，否则整图重挂载） */
export const graphCardNodeTypes = { graphCard: GraphCard }
