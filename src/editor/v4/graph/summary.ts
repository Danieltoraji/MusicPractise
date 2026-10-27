/**
 * v4 节点卡信息（千星「节点=信息卡」思路）：kind 中文名 + 单行语句摘要。
 *
 * 卡片正文直接复用 `engine/v4/script.nodeScriptText`——图、伪代码、检查器三处对
 * 同一节点的文本口径完全一致（「单一 IR 三视图」的投影一致性，docs/53 §13.5）。
 */
import type { BehaviorNode, FlowNode } from '../../../engine/v4/model'
import { nodeScriptText } from '../../../engine/v4/script'
import type { AnyGraphNode } from './ops'

export interface KindMeta {
  /** 中文名（节点卡标题） */
  label: string
}

export const FLOW_KIND_META: Record<FlowNode['kind'], KindMeta> = {
  start: { label: '开始' },
  assign: { label: '赋值' },
  call: { label: '动作' },
  setView: { label: '切换视图' },
  ask: { label: '提问' },
  foreach: { label: '遍历' },
  branch: { label: '分支' },
  loop: { label: '循环' },
  wait: { label: '等待' },
  waitShell: { label: '等待事件' },
  finish: { label: '结算' },
  restart: { label: '重开' },
  comment: { label: '注释' },
}

export const BEHAVIOR_KIND_META: Record<BehaviorNode['kind'], KindMeta> = {
  on: { label: '事件' },
  return: { label: '返回' },
  assign: { label: '赋值' },
  call: { label: '动作' },
  emit: { label: '派发' },
  branch: { label: '分支' },
  loop: { label: '循环' },
  wait: { label: '等待' },
  setView: { label: '切换视图' },
  comment: { label: '注释' },
}

/** 节点卡标题：kind 中文名 */
export function nodeKindLabel(node: AnyGraphNode): string {
  return node.kind in FLOW_KIND_META
    ? FLOW_KIND_META[node.kind as FlowNode['kind']].label
    : BEHAVIOR_KIND_META[node.kind as BehaviorNode['kind']].label
}

/** 节点卡正文行（当前 = 单行语句文本；长文本由 CSS 省略号截断，title 可看全） */
export function summarizeNode(node: AnyGraphNode): string[] {
  return [nodeScriptText(node)]
}
