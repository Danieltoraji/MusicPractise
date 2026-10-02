/**
 * 编辑器 AI 的上下文组装：system prompt（关卡结构 + 组件/变量/表清单 + 语法摘要）
 * 与用户消息的选中上下文前缀（画布组件 / 图节点 / 脚本选区）。
 * 只依赖 engine/runtime 层——src/ai 保持编辑器无关（面板在编辑器层）。
 */

import type { GNode } from '../engine/graphProgram'
import { COLUMN_TYPE_LABELS } from '../engine/level'
import type { Json } from '../engine/expr'
import type { LevelDoc } from '../engine/level'
import { getDef } from '../runtime/store'

/** 编辑器各视图上报给 AI 面板的选中上下文（tab 粒度必填，具体选中可缺） */
export interface AiSelectionContext {
  tab: 'canvas' | 'graph' | 'script' | 'table' | 'json'
  /** 画布选中的组件 id */
  componentId?: string | null
  /** 节点图选中的节点 id */
  nodeId?: string | null
  /** 脚本页选中的文本范围（行号 1 起） */
  scriptRange?: { startLine: number; endLine: number; text: string } | null
}

const TAB_LABEL: Record<AiSelectionContext['tab'], string> = {
  canvas: '画布',
  graph: '节点图',
  script: '脚本',
  table: '数据表',
  json: 'JSON',
}

/** 节点单行摘要（上下文与 read_script 降级共用） */
export function describeGNode(n: GNode): string {
  switch (n.kind) {
    case 'on':
      return `on ${n.event}`
    case 'call':
      return `${n.target}.${n.method}(${(n.args ?? []).join(', ')})`
    case 'assign':
      return 'expr' in n.value
        ? `v.${n.target} = ${n.value.expr}`
        : `v.${n.target} = ${n.value.call.target}.${n.value.call.method}(...)`
    case 'branch':
      return `if (${n.cond})`
    case 'loop':
      return n.mode === 'while' ? `while (${n.cond ?? '?'})` : `repeat (${n.times ?? '?'})`
    case 'wait':
      return `wait (${n.ms})`
    case 'emit':
      return `emit '${n.event}'`
    case 'comment':
      return `// ${n.text}`
    default:
      return JSON.stringify(n)
  }
}

function safeContract(type: string): { displayName: string; events: Record<string, string>; commands: Record<string, string> } | null {
  try {
    const def = getDef(type)
    return { displayName: def.contract.displayName, events: def.contract.events, commands: def.contract.commands }
  } catch {
    return null
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断，可用 read_json 看更多）` : text
}

/** 组装编辑器 system prompt：角色 + 关卡结构说明 + 当前关卡完整清单 */
export function buildEditorSystemPrompt(doc: LevelDoc): string {
  const lines: string[] = []
  lines.push(
    '你是「音乐练习 UGC 平台」关卡编辑器内的 AI 助手，当前为 ask 模式：只能读取与诊断（read_script / read_doc / read_json / lint / read_run_log 工具），不能修改关卡。',
    '用简体中文回答。引用具体组件 id、节点 id、表列名，让用户能直接定位。',
    '',
    '## 关卡结构（LevelDoc v3）',
    '- content.views：互斥视图；content.components：组件实例（id/type/view/layout/props）；content.logic：GraphProgram v2 事件驱动节点图（on 事件处理器 → call/assign/branch/loop/wait/emit 节点）；content.table：题目数据表（q.* 指向当前行，行指针 v.__row）；content.flow：推进与过关条件（pass.expr）。',
    '- 表达式作用域：v.变量、q.表列、event.事件负载；函数白名单含 len/join/append/randomInt 等。',
    '- 伪代码（LevelScript）与节点图是同一逻辑的双投影：on 事件 { … } 块、v.x = 表达式、实例.方法(参数)、if/else、while/repeat、wait、emit。',
    '',
    `## 当前关卡：${String(doc.meta.title ?? '')}（id=${doc.id}，v${doc.version}）`,
  )

  lines.push('', '### 组件')
  const comps = doc.content.components
  if (comps.length === 0) lines.push('（无组件）')
  for (const c of comps) {
    const contract = safeContract(c.type)
    const events = contract ? Object.keys(contract.events).join('/') : ''
    const commands = contract ? Object.keys(contract.commands).join('/') : ''
    const view = c.view ?? doc.content.views[0]?.id ?? 'main'
    lines.push(
      `- ${c.id}（${c.type}${contract ? `·${contract.displayName}` : ''}${c.name ? `·${c.name}` : ''}·视图 ${view}${c.visible === false ? '·隐藏' : ''}）事件: ${events || '无'} 命令: ${commands || '无'}`,
    )
  }

  lines.push('', '### 变量（logic.variables 初始值）')
  const vars = doc.content.logic.variables ?? {}
  const varKeys = Object.keys(vars)
  lines.push(varKeys.length === 0 ? '（未声明）' : varKeys.map((k) => `${k}=${JSON.stringify(vars[k])}`).join(', '))

  lines.push('', '### 数据表')
  const table = doc.content.table
  const cols = table.columns
    .map((col) => `${col.key}(${COLUMN_TYPE_LABELS[col.type ?? 'json'] ?? 'JSON'}${col.label ? `·${col.label}` : ''})`)
    .join('、')
  lines.push(`列：${cols || '（无）'}；共 ${table.rows.length} 行（q.<列名> 取当前行值）`)

  lines.push('', '### 视图')
  lines.push(doc.content.views.map((v) => `${v.id}${v.name ? `(${v.name})` : ''}`).join('、'))

  const flow = doc.content.flow
  if (flow) {
    lines.push('', `### 推进：order=${flow.order ?? 'sequential'}${flow.count ? `，count=${flow.count}` : ''}${flow.pass ? `，过关条件 pass=${flow.pass.expr}` : ''}`)
  }
  return lines.join('\n')
}

/** 把选中上下文序列化为用户消息前缀；无任何具体选中时返回空串 */
export function formatSelectionContext(sel: AiSelectionContext | null | undefined, doc: LevelDoc): string {
  if (!sel) return ''
  const parts: string[] = [`当前页面：${TAB_LABEL[sel.tab]}`]
  if (sel.tab === 'canvas' && sel.componentId) {
    const c = doc.content.components.find((x) => x.id === sel.componentId)
    if (c) {
      const props = Object.keys((c.props ?? {}) as Record<string, Json>)
      parts.push(
        `选中组件 ${c.id}（${c.type}${c.name ? `·${c.name}` : ''}）props: ${props.join('/') || '无'}`,
      )
    }
  }
  if (sel.tab === 'graph' && sel.nodeId) {
    const n = doc.content.logic.nodes.find((x) => x.id === sel.nodeId)
    if (n) parts.push(`选中节点 ${n.id}：${describeGNode(n)}`)
  }
  if (sel.tab === 'script' && sel.scriptRange && sel.scriptRange.text.trim() !== '') {
    const r = sel.scriptRange
    parts.push(`选中脚本 第 ${r.startLine}–${r.endLine} 行：\n${truncate(r.text, 600)}`)
  }
  return parts.length > 1 ? parts.join('；') : ''
}
