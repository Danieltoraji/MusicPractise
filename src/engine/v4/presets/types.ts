/**
 * v4 预设类型（docs/53 §14；docs/51 §3.5「预设，而不是策略」）。
 *
 * 预设 = **普通节点组 + comment**（印章式）：`build()` 只返回普通 IR 节点/边，
 * 不写任何 `preset` 运行期元数据、不引入隐藏策略枚举；插入后作者可在图工作台/伪代码/JSON
 * 里像手写节点一样继续修改、删除、重连。
 *
 * 本文件只依赖 engine/v4/model 的类型（不得反向依赖 runtime/editor，编译期无副作用）。
 */
import type { Json } from '../../expr'
import type { BehaviorNode, FlowNode, GraphEdge, LevelDocV4 } from '../model'

/** 预设所在层：flow = 关卡主流程；behavior = 题型行为（一次 ask 调用） */
export type PresetLayer = 'flow' | 'behavior'

/** 预设参数控件类型（docs/53 §14） */
export type PresetParamType = 'expr' | 'text' | 'number' | 'select'

export interface PresetParamOption {
  value: string
  label: string
}

/** 预设参数定义（docs/53 §14；表单渲染 + 默认值/合法性校验的唯一真源） */
export interface PresetParamDef {
  key: string
  label: string
  type: PresetParamType
  default?: Json
  options?: PresetParamOption[]
}

/** `build()` 的产物：普通节点 + 普通边（+ 入口节点/说明），不含任何运行期策略元数据 */
export interface PresetBuildResult {
  nodes: (FlowNode | BehaviorNode)[]
  edges: GraphEdge[]
  /** 片段入口节点 id（调用方把它接到上游链尾；behavior 层为新增的 `on` 节点） */
  entryId?: string
  /** 节点组说明（同时生成为一个 comment 节点，作者可改/删） */
  comment?: string
}

/** `build()` 的上下文：当前文档（用于稳定 id 分配/默认值推断）与题型 id（behavior 层必填） */
export interface PresetCtx {
  doc: LevelDocV4
  typeId?: string
}

/** 预设定义（docs/53 §14 冻结形状；PRESET_CATALOG 的条目类型） */
export interface PresetDef {
  id: string
  name: string
  description: string
  layer: PresetLayer
  params: PresetParamDef[]
  build(ctx: PresetCtx, params: Record<string, Json>): PresetBuildResult
}
