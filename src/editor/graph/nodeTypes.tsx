/**
 * 图节点的信息卡渲染（千星沙箱「节点=信息卡」思想）：
 * 色带分型 + 中文名 + 参数摘要印在卡上，右栏 Inspector 只做精细编辑。
 * Handle 与 docs/13 端口协议一致：on 无入边；branch/loop 右侧 true/false 双出口（绿/红）；
 * 其余单出边（handle id 'out' → 边无端口）。
 */
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { GNode } from '../../engine/graphProgram'

export interface GraphCardData extends Record<string, unknown> {
  node: GNode
  /** 该节点的 lint 消息（红框 + ⚠ + title 提示） */
  errors?: string[]
}
export type GraphCardNode = Node<GraphCardData, 'graphCard'>

const KIND_META: Record<GNode['kind'], { color: string; label: string }> = {
  on: { color: '#7c3aed', label: '事件' },
  call: { color: '#2563eb', label: '动作' },
  assign: { color: '#16a34a', label: '赋值' },
  emit: { color: '#d97706', label: '触发' },
  branch: { color: '#ea580c', label: '分支' },
  loop: { color: '#ea580c', label: '循环' },
  wait: { color: '#ea580c', label: '等待' },
  comment: { color: '#6b7280', label: '注释' },
}

/** 参数摘要行（只读印卡；超长截断） */
function summaryLines(node: GNode): string[] {
  const clip = (s: string, n = 26): string => (s.length > n ? `${s.slice(0, n)}…` : s)
  switch (node.kind) {
    case 'on':
      return [clip(node.event)]
    case 'call':
      return [`${node.target}.${node.method}(…)`, ...node.args.map((a) => clip(a))]
    case 'assign':
      return [`v.${node.target} = ${'expr' in node.value ? clip(node.value.expr) : `${node.value.call.target}.${node.value.call.method}()`}`]
    case 'branch':
      return [`if (${clip(node.cond)})`]
    case 'loop':
      return [node.mode === 'while' ? `while (${clip(node.cond ?? '')})` : `repeat (${clip(node.times ?? '')})`]
    case 'wait':
      return [`${clip(node.ms)} ms`]
    case 'emit': {
      const payload = Object.keys(node.payload ?? {})
      return [clip(node.event), ...(payload.length ? [`{ ${payload.join(', ')} }`] : [])]
    }
    case 'comment':
      return [clip(node.text, 40)]
  }
}

/** 模块级稳定注册（React Flow 要求 nodeTypes 引用稳定） */
function GraphCard({ data, selected }: NodeProps<GraphCardNode>) {
  const node = data.node
  const meta = KIND_META[node.kind]
  const errors = data.errors ?? []
  const dual = node.kind === 'branch' || node.kind === 'loop'
  return (
    <div
      className={`gnode ${selected ? 'is-selected' : ''} ${errors.length ? 'has-error' : ''}`}
      title={errors.length ? errors.join('\n') : undefined}
    >
      <div className="gnode-band" style={{ background: meta.color }} />
      <div className="gnode-head">
        <span className="gnode-kind" style={{ color: meta.color }}>{meta.label}</span>
        {errors.length > 0 && <span className="gnode-badge" title={errors[0]}>⚠</span>}
      </div>
      <div className="gnode-body">
        {summaryLines(node).map((line, i) => (
          <div key={i} className="gnode-line">{line}</div>
        ))}
      </div>
      {node.kind !== 'on' && <Handle type="target" position={Position.Left} id="in" isConnectable />}
      {dual ? (
        <>
          <Handle type="source" position={Position.Right} id="true" className="gport-true" style={{ top: 14 }} isConnectable />
          <Handle type="source" position={Position.Right} id="false" className="gport-false" style={{ top: 'calc(100% - 14px)' }} isConnectable />
          <span className="gport-label" style={{ top: 6 }}>真</span>
          <span className="gport-label" style={{ bottom: 6 }}>假</span>
        </>
      ) : (
        <Handle type="source" position={Position.Right} id="out" isConnectable />
      )}
    </div>
  )
}

export const graphCardNodeTypes = { graphCard: GraphCard }
