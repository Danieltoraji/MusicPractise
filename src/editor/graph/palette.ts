/**
 * 节点库候选：从关卡文档（组件实例 + 组件契约）构造可添加的节点菜单。
 * 纯函数、无 React 依赖——左栏节点库与画布右键菜单共用（千星沙箱的右键建节点交互）。
 * make 只产节点形状（Omit id），id 由调用方用 newNodeId 补齐后走 addNode（校验集中一处）。
 */
import type { LevelDoc } from '../../engine/level'
import type { Json } from '../../engine/expr'
import type { GNode } from '../../engine/graphProgram'
import { allContracts } from '../../runtime/store'

export type PaletteGroupId = 'event' | 'action' | 'level' | 'variable' | 'flow'

/** 分布式 Omit：保留 union 各成员的特定字段（普通 Omit 会塌缩成交集） */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
export type NodeShape = DistributiveOmit<GNode, 'id'>

export interface PaletteItem {
  /** 组内唯一键（React key / 右键菜单定位） */
  key: string
  label: string
  desc?: string
  make(pos?: { x: number; y: number }): NodeShape
}

export interface PaletteGroup {
  id: PaletteGroupId
  label: string
  hint: string
  items: PaletteItem[]
}

/** 模板内部连线的端点引用（make 产物 nodes 的数组下标） */
export interface TemplateLink {
  from: number
  to: number
  port?: 'true' | 'false'
}

/** 一键模板：一次落一组预连节点（结构示范，节点自带相对坐标） */
export interface PaletteTemplate {
  key: string
  label: string
  desc: string
  /** 落图时合并声明的变量（关卡已声明的跳过）——避免模板节点引用未声明变量即红卡 */
  requiredVars?: Record<string, Json>
  make(pos?: { x: number; y: number }): { nodes: NodeShape[]; links: TemplateLink[] }
}

const at = (pos?: { x: number; y: number }): { x?: number; y?: number } => (pos ? { x: pos.x, y: pos.y } : {})

const rel = (pos: { x: number; y: number } | undefined, dx: number, dy: number): { x: number; y: number } => ({
  x: (pos?.x ?? 0) + dx,
  y: (pos?.y ?? 0) + dy,
})

/** 模板候选：按文档可用组件过滤（如防卡死守卫需要 timer 组件） */
export function buildTemplates(doc: LevelDoc): PaletteTemplate[] {
  const hasTimer = doc.content.components.some((c) => c.type === 'timer')
  const timerId = doc.content.components.find((c) => c.type === 'timer')?.id ?? 'timer1'
  const templates: PaletteTemplate[] = [
    {
      key: 'tpl-score-gate',
      label: '计分初始化与门槛结算',
      desc: '关卡开始时清零 score；每题装载后若 score ≥ 10 主动结算（可改门槛与条件）',
      requiredVars: { score: 0 },
      make(pos) {
        const p = pos ?? { x: 0, y: 0 }
        return {
          nodes: [
            { kind: 'on', event: 'level.started', ...rel(p, 0, 0) },
            { kind: 'assign', target: 'score', value: { expr: '0' }, ...rel(p, 280, 0) },
            { kind: 'on', event: 'level.questionLoaded', ...rel(p, 0, 170) },
            { kind: 'branch', cond: 'v.score >= 10', ...rel(p, 280, 170) },
            { kind: 'call', target: 'level', method: 'finish', args: [], ...rel(p, 560, 170) },
          ],
          links: [
            { from: 0, to: 1 },
            { from: 2, to: 3 },
            { from: 3, to: 4, port: 'true' },
          ],
        }
      },
    },
  ]
  if (hasTimer) {
    templates.push({
      key: 'tpl-timeout-guard',
      label: '防卡死守卫',
      desc: `关卡开始后 ${timerId} 计时 30 秒，tick 触发即强制结算——防止玩家卡在无提示的题目里`,
      make(pos) {
        const p = pos ?? { x: 0, y: 0 }
        return {
          nodes: [
            { kind: 'on', event: 'level.started', ...rel(p, 0, 0) },
            { kind: 'call', target: timerId, method: 'start', args: ['{ms: 30000}'], ...rel(p, 280, 0) },
            { kind: 'on', event: `${timerId}.tick`, ...rel(p, 0, 170) },
            { kind: 'call', target: 'level', method: 'finish', args: [], ...rel(p, 280, 170) },
          ],
          links: [
            { from: 0, to: 1 },
            { from: 2, to: 3 },
          ],
        }
      },
    })
  }
  return templates
}

/** 从关卡文档构造节点库（顺序：事件 → 实例动作 → level → 变量 → 控制流） */
export function buildPalette(doc: LevelDoc): PaletteGroup[] {
  const contracts = new Map(allContracts().map((c) => [c.type, c]))
  const comps = doc.content.components

  // 事件组：生命周期 + 每实例事件
  const eventItems: PaletteItem[] = [
    {
      key: 'evt-level.started',
      label: '关卡开始',
      desc: 'level.started——进入关卡后触发一次',
      make: (pos) => ({ kind: 'on', event: 'level.started', ...at(pos) }),
    },
    {
      key: 'evt-level.questionLoaded',
      label: '题目装载',
      desc: 'level.questionLoaded——每道题装载后触发（payload: index/total）',
      make: (pos) => ({ kind: 'on', event: 'level.questionLoaded', ...at(pos) }),
    },
    {
      key: 'evt-level.finished',
      label: '关卡结算',
      desc: 'level.finished——结算时触发（payload: score/passed）',
      make: (pos) => ({ kind: 'on', event: 'level.finished', ...at(pos) }),
    },
  ]
  for (const comp of comps) {
    const contract = contracts.get(comp.type)
    if (!contract) continue
    for (const [event, payloadDoc] of Object.entries(contract.events)) {
      const name = comp.name?.trim() || comp.id
      eventItems.push({
        key: `evt-${comp.id}.${event}`,
        label: `${name} · ${event}`,
        desc: `${comp.id}.${event}${payloadDoc ? `（${payloadDoc}）` : ''}`,
        make: (pos) => ({ kind: 'on', event: `${comp.id}.${event}`, ...at(pos) }),
      })
    }
  }

  // 实例动作组：每实例 × 契约命令（过滤 __ 内部命令）
  const actionItems: PaletteItem[] = []
  for (const comp of comps) {
    const contract = contracts.get(comp.type)
    if (!contract) continue
    const name = comp.name?.trim() || comp.id
    for (const [cmd, argDoc] of Object.entries(contract.commands)) {
      if (cmd.startsWith('__')) continue
      actionItems.push({
        key: `act-${comp.id}.${cmd}`,
        label: `${name} · ${cmd}`,
        desc: `${comp.id}.${cmd}${argDoc ? `——参数 ${argDoc}` : ''}`,
        make: (pos) => ({ kind: 'call', target: comp.id, method: cmd, args: [], ...at(pos) }),
      })
    }
  }

  // level 伪实例动作
  const levelItems: PaletteItem[] = [
    { key: 'lvl-next', label: '进入下一题', desc: 'level.next——末题则自动结算', make: (pos) => ({ kind: 'call', target: 'level', method: 'next', args: [], ...at(pos) }) },
    { key: 'lvl-restart', label: '重开本关', desc: 'level.restart——变量/组件状态重置并重新开始', make: (pos) => ({ kind: 'call', target: 'level', method: 'restart', args: [], ...at(pos) }) },
    { key: 'lvl-finish', label: '结算关卡', desc: 'level.finish——主动结算，可传 { passed: false } 强制未通过', make: (pos) => ({ kind: 'call', target: 'level', method: 'finish', args: [], ...at(pos) }) },
  ]

  // 变量赋值组：按已声明变量
  const variableItems: PaletteItem[] = Object.keys(doc.content.logic.variables ?? {}).map((name) => ({
    key: `var-assign-${name}`,
    label: `v.${name} = …`,
    desc: `给变量 ${name} 赋值（表达式或查询调用）`,
    make: (pos) => ({ kind: 'assign', target: name, value: { expr: '0' }, ...at(pos) }),
  }))

  // 控制流组（默认值取有界/合法形态，避免添加即 lint 报错）
  const flowItems: PaletteItem[] = [
    { key: 'flow-branch', label: '条件分支', desc: '条件为真走「真」出口，否则走「假」出口', make: (pos) => ({ kind: 'branch', cond: 'true', ...at(pos) }) },
    { key: 'flow-repeat', label: '固定次数循环', desc: 'repeat——重复执行循环体 N 次', make: (pos) => ({ kind: 'loop', mode: 'repeat', times: '3', ...at(pos) }) },
    { key: 'flow-while', label: '条件循环', desc: 'while——条件为真时重复循环体（注意循环体要回到循环头）', make: (pos) => ({ kind: 'loop', mode: 'while', cond: 'false', ...at(pos) }) },
    { key: 'flow-wait', label: '等待毫秒', desc: 'wait——暂停本条执行流（不阻塞其它事件）', make: (pos) => ({ kind: 'wait', ms: '500', ...at(pos) }) },
    { key: 'flow-emit', label: '触发内部事件', desc: "emit——派发内部事件「名:名」，唤醒对应的 on 处理器", make: (pos) => ({ kind: 'emit', event: 'app:burst', ...at(pos) }) },
    { key: 'flow-comment', label: '注释', desc: '纯标注，执行时直通', make: (pos) => ({ kind: 'comment', text: '说明…', ...at(pos) }) },
  ]

  return [
    { id: 'event', label: '事件', hint: '执行流的唯一起点', items: eventItems },
    { id: 'action', label: '实例动作', hint: '调用组件命令', items: actionItems },
    { id: 'level', label: '关卡', hint: 'level 伪实例的方法', items: levelItems },
    { id: 'variable', label: '变量赋值', hint: '给已声明变量赋值', items: variableItems },
    { id: 'flow', label: '控制流', hint: '分支 / 循环 / 等待 / 触发', items: flowItems },
  ]
}
