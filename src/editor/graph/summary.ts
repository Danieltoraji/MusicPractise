/**
 * 节点信息卡的中文摘要（3-5 友好化）：把 IR 字段翻译成「当 XX 被点击 / 调用 XX」级别
 * 的自然语言。纯函数、不依赖 React；事件尾部词与契约事件名对照，未收录的回退原文。
 */
import type { GNode } from '../../engine/graphProgram'
import { argsToArgView } from './exprBridge'

export interface CompInfo {
  id: string
  name?: string
  type: string
}

/** 实例友好名：优先用户命名，其次 id */
export function compLabel(comps: CompInfo[] | undefined, id: string): string {
  const c = comps?.find((x) => x.id === id)
  return c ? (c.name || c.id) : id
}

const LEVEL_EVENT_ZH: Record<string, string> = {
  'level.started': '关卡开始',
  'level.questionLoaded': '题目载入',
  'level.finished': '关卡结算',
}

const EVENT_TAIL_ZH: Record<string, string> = {
  clicked: '被点击',
  changed: '值改变',
  chosen: '被选择',
  submitted: '提交',
  tick: '计时到点',
  noteClicked: '点击音符',
  keyClicked: '按下琴键',
  tap: '敲击',
  roundDone: '一轮结束',
  pitch: '检测到音高',
}

/** 事件名 → 友好描述（level.started → 关卡开始；btn1.clicked → 按钮·被点击） */
export function friendlyEvent(event: string, comps?: CompInfo[]): string {
  const zh = LEVEL_EVENT_ZH[event]
  if (zh) return zh
  const dot = event.indexOf('.')
  if (dot > 0) {
    const head = event.slice(0, dot)
    const tail = event.slice(dot + 1)
    return `${compLabel(comps, head)}·${EVENT_TAIL_ZH[tail] ?? tail}`
  }
  return event
}

const clip = (s: string, n = 22): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 参数摘要行（印卡用）：第一行主描述，后续行为参数明细 */
export function summarizeNode(node: GNode, comps?: CompInfo[]): string[] {
  switch (node.kind) {
    case 'on':
      return [`当 ${clip(friendlyEvent(node.event, comps), 30)}`]
    case 'call': {
      const head = `${compLabel(comps, node.target)}·${node.method}`
      const view = argsToArgView(node.args)
      if (view.mode === 'none') return [head]
      if (view.mode === 'object') {
        return [view.entries.length > 0 ? `${head} { ${view.entries.map((e) => e.key).join(', ')} }` : head]
      }
      return [head, clip(view.sources[0] ?? '', 26)]
    }
    case 'assign': {
      const right =
        'expr' in node.value
          ? clip(node.value.expr)
          : `${compLabel(comps, node.value.call.target)}·${node.value.call.method}()`
      return [`v.${node.target} = ${right}`]
    }
    case 'branch':
      return [`如果 ${clip(node.cond)}`]
    case 'loop':
      return node.mode === 'while' ? [`只要 ${clip(node.cond ?? '')} 就循环`] : [`重复 ${clip(node.times ?? '')} 次`]
    case 'wait':
      return [`等待 ${clip(node.ms)} 毫秒`]
    case 'emit': {
      const keys = Object.keys(node.payload ?? {})
      return [`触发 ${clip(node.event, 24)}`, ...(keys.length ? [`{ ${keys.join(', ')} }`] : [])]
    }
    case 'comment':
      return [clip(node.text, 40)]
  }
}
