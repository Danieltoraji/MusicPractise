/**
 * 编辑器 AI 的上下文组装：system prompt（关卡结构 + 组件/变量/表清单 + 语法摘要）
 * 与用户消息的选中上下文前缀（画布组件 / 图节点 / 脚本选区）。
 * 只依赖 engine/runtime 层——src/ai 保持编辑器无关（面板在编辑器层）。
 */

import type { GNode } from '../engine/graphProgram'
import { COLUMN_TYPE_LABELS } from '../engine/level'
import type { Json } from '../engine/expr'
import type { LevelDoc } from '../engine/level'
import type { PropFieldDef } from '../runtime/componentDef'
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

function safeContract(type: string): {
  displayName: string
  events: Record<string, string>
  commands: Record<string, string>
  queries: Record<string, string>
  propsDoc?: string
  propsFields?: PropFieldDef[]
} | null {
  try {
    const def = getDef(type)
    return {
      displayName: def.contract.displayName,
      events: def.contract.events,
      commands: def.contract.commands,
      queries: def.contract.queries ?? {},
      propsDoc: def.contract.propsDoc,
      propsFields: def.contract.propsFields,
    }
  } catch {
    return null
  }
}

/** F3（docs/42 §5.1）：单条契约文本上限——props 说明/字段清单可能很长，逐条截断防提示词爆炸 */
export const CONTRACT_TEXT_MAX = 200

/** 单条契约文本截断到 CONTRACT_TEXT_MAX 字符（模型仍可用 read_json 看完整 props） */
export function clipContractText(text: string): string {
  return text.length > CONTRACT_TEXT_MAX ? `${text.slice(0, CONTRACT_TEXT_MAX)}…` : text
}

/** props 契约段：结构化字段（name:type[选项]=默认）+ 自由说明（F3 缺口：此前完全缺失） */
export function formatPropsContract(contract: { propsFields?: PropFieldDef[]; propsDoc?: string }): string {
  const parts: string[] = []
  if (contract.propsFields && contract.propsFields.length > 0) {
    parts.push(
      contract.propsFields
        .map(
          (f) =>
            `${f.key}:${f.type}${f.options && f.options.length > 0 ? `[${f.options.join('|')}]` : ''}${
              f.fallback !== undefined ? `=${JSON.stringify(f.fallback)}` : ''
            }`,
        )
        .join('、'),
    )
  }
  if (contract.propsDoc) parts.push(contract.propsDoc)
  return parts.map(clipContractText).join('；')
}

/** F3（docs/40）：契约「值」就是负载/参数形状说明——只下发键名曾让 AI 猜错 payload 静默无效 */
function contractSegment(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([k, v]) => `${k}(${clipContractText(v)})`)
    .join('/')
}

/** 生命周期事件目录（与事件管理面板同源语义）：从零写逻辑时不再靠猜。read_doc 复用同一份目录 */
export const LIFECYCLE_CATALOG =
  'level.started（进入关卡一次）/ level.finished（结算，payload: score/passed）/ ' +
  'question.loaded（每行装载，payload: index/total/row）/ view.entered（切视图，payload: view）'

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断，可用 read_json 看更多）` : text
}

/** 组装编辑器 system prompt：角色 + 关卡结构说明 + 当前关卡完整清单；mode 决定权限边界说明 */
export function buildEditorSystemPrompt(doc: LevelDoc, mode: 'ask' | 'plan' | 'agent' = 'ask'): string {
  const lines: string[] = []
  if (mode === 'agent') {
    lines.push(
      '你是「音乐练习 UGC 平台」关卡编辑器内的 AI 助手，当前为 agent 模式：可以通过写入工具直接修改关卡' +
        '（write_script / edit_table / edit_components / edit_meta / edit_views / edit_flow / set_variable），每次修改都会先过校验再应用。',
      '修改守则：保持最小必要修改；先 read_script / read_doc 了解现状再动手；数据表行的 key 必须与现有列完全一致；' +
        '逻辑修改用 write_script 全文交付（不是增量补丁）；新增组件后用返回的新 id 在逻辑中引用；每次写入后以返回的校验结果为准，被拒绝就修正重试。',
      '效率守则：多个独立的小修改尽量合并——优先用批量参数（set_variable 的 vars、edit_components 的 items/updates/ids、edit_views 的 ops、debug_dispatch 的 events 剧本），' +
        '或同一轮里发起多个工具调用；不要把每个小步骤都拆成单独一来回，也不必反复重读刚读过的内容。',
      '事件守则：组件事件名只从契约清单取（system prompt 组件段与 read_doc 的 events/commands 字段），绝不臆测不存在的事件名；' +
        '不确定某事件是否存在时，用 run_level 一次注入全部候选事件并依据「无处理器命中」清单判断，不要写多版本探测脚本逐个试。',
      '验证守则：修改后用 run_level 无头试运行验证（events 注入用户操作，如点按钮/按键），依据运行错误与变量终态继续修正，直到结算符合预期。',
      '调试守则：需要逐步排查或向创作者演示时用调试工具组——debug_control(start) 启动的是**可见调试会话**（游玩画面出现在工作台左侧，创作者实时看到你触发的每个事件与画面反应；调试中画面点击与 debug_dispatch 同路径）。' +
        '配合 debug_breakpoints 设断点、debug_read 看变量与日志、debug_set_var 强设状态、debug_screenshot 截调试画面（无会话时回落节点图）。讨论具体节点时用 highlight_nodes 高亮给创作者看。',
      '截图守则：需要「看」或给创作者展示时用 capture_screen——target=graph 截节点图（结构/位置），target=canvas 截关卡画布预览（布局与外观，仅画布/布局视图下可用），target=debug 截调试运行画面（需调试会话在跑）。',
      '',
    )
  } else if (mode === 'plan') {
    lines.push(
      '你是「音乐练习 UGC 平台」关卡编辑器内的 AI 助手，当前为 plan 模式：只能读取与调研（read_script / read_doc / read_json / lint / read_run_log），不能修改关卡。',
      '任务：针对用户需求产出一份**编号执行计划**（用户确认后由 agent 模式逐项执行）。输出格式（严格遵守）：',
      '- 第一行：一句话目标概述；',
      '- 随后每项一行，格式 `序号. [写入工具名] 具体做什么`（序号用 1. 2. 3.；写入工具=write_script/edit_table/edit_components/edit_meta/edit_views/edit_flow/set_variable）；',
      '- 每项写到「直接可执行」的粒度（具体到目标组件 id / 表列 key / 事件名；逻辑修改写明改动点与伪代码要点）；',
      '- 最后一项固定为验证（如 `N. [run_level] 验证：…`）。',
      '除导语与清单外不要输出其他内容；清单行必须一行一项；绝不调用写入工具。',
      '',
    )
  } else {
    lines.push(
      '你是「音乐练习 UGC 平台」关卡编辑器内的 AI 助手，当前为 ask 模式：只能读取与诊断（read_script / read_doc / read_json / lint / read_run_log / run_level / capture_screen 截图等只读工具），不能修改关卡。',
      '',
    )
  }
  lines.push(
    '用简体中文回答；引用具体组件 id、节点 id、表列名，让用户能直接定位。',
    '',
    '## 关卡结构（LevelDoc v3）',
    '- content.views：互斥视图；content.components：组件实例（id/type/view/layout/props）；content.logic：GraphProgram v2 事件驱动节点图（on 事件处理器 → call/assign/branch/loop/wait/emit 节点）；content.table：题目数据表（q.* 指向当前行，行指针 v.__row）；content.flow：推进与过关条件（pass.expr）。',
    '- 表达式作用域：v.变量、q.表列、event.事件负载；函数白名单含 len/join/append/randomInt 等。',
    '- 伪代码（LevelScript）与节点图是同一逻辑的双投影：on 事件 { … } 块、v.x = 表达式、实例.方法(参数)、if/else、while/repeat、wait、emit。',
    '',
    `## 当前关卡：${String(doc.meta.title ?? '')}（id=${doc.id}，v${doc.version}）`,
  )

  lines.push('', '### 组件', `生命周期事件目录（on 入口可用）：${LIFECYCLE_CATALOG}`)
  const comps = doc.content.components
  if (comps.length === 0) lines.push('（无组件）')
  for (const c of comps) {
    const contract = safeContract(c.type)
    const events = contract ? contractSegment(contract.events) : ''
    const commands = contract ? contractSegment(contract.commands) : ''
    const queries = contract ? contractSegment(contract.queries) : ''
    // F3（docs/42 §5.1）：props 契约（结构化字段 + 说明）此前完全缺失——AI 只能从示例猜测
    const props = contract ? formatPropsContract(contract) : ''
    const view = c.view ?? doc.content.views[0]?.id ?? 'main'
    lines.push(
      `- ${c.id}（${c.type}${contract ? `·${contract.displayName}` : ''}${c.name ? `·${c.name}` : ''}·视图 ${view}${c.visible === false ? '·隐藏' : ''}）事件: ${events || '无'} 命令: ${commands || '无'}${queries ? ` 查询: ${queries}` : ''}${props ? ` 属性: ${props}` : ''}`,
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

/** 构建「执行计划」的指令（plan-act：逐项执行 + update_plan 标记进度） */
export function buildPlanExecutionPrompt(items: { text: string }[]): string {
  const lines = items.map((it, i) => `${i + 1}. ${it.text}`)
  return [
    '请严格逐项执行以下已确认的计划：',
    ...lines,
    '',
    '要求：用 update_plan 工具标记进度（marks 数组支持批量）——开始某项时把该项标 in_progress，完成时标 done；',
    '尽量合并标记以减少来回：开始下一项时，可在同一次 update_plan 调用里把上一项标 done、当前项标 in_progress；',
    '无法完成的项标为 skipped 并说明原因；全部项处理完后简短汇报结果。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 一键预设指令（批次6d）：面板头部快捷按钮，一条指令完成常见任务
// ---------------------------------------------------------------------------

export interface PresetCommand {
  key: string
  label: string
  tip: string
  mode: 'ask' | 'agent'
  instruction: string
}

export const PRESET_COMMANDS: PresetCommand[] = [
  {
    key: 'review',
    label: '🔍 审查关卡',
    tip: '全面体检：lint/逻辑/数据一致性/体验，输出结构化报告并标注问题节点（只读）',
    mode: 'ask',
    instruction:
      '请对本关卡做一次全面审查，逐项检查后输出结构化报告，固定四个小节：' +
      '【问题】（lint 错误、逻辑漏洞如未声明的变量/悬空引用/永假条件、数据表缺列空值、视图与组件错配——用 highlight_nodes 高亮问题节点）、' +
      '【建议】（体验与结构改进，按优先级排序）、' +
      '【亮点】（设计得好的地方）、' +
      '【总结】（一句话总评）。只读取与诊断，不修改关卡。',
  },
  {
    key: 'gen-questions',
    label: '📝 批量出题',
    tip: '按现有数据表结构批量追加题目行（agent：先读列结构，确认后写入）',
    mode: 'agent',
    instruction:
      '请为数据表批量出题：先用 read_doc 读现有列结构与已有行做参考（风格/难度保持一致），' +
      '然后追加 5 道新题（列 key 必须与现有列完全一致；notes 列用音符串格式 [{midi,dur}]）；' +
      '完成后跑 lint 确认无警告，并汇报新增行数。',
  },
  {
    key: 'gen-intro',
    label: '📖 生成介绍',
    tip: '根据关卡内容生成一段描述，写入 meta.description（agent）',
    mode: 'agent',
    instruction:
      '请通读本关卡（read_script + read_doc），写一段 60–120 字的关卡介绍（面向玩家：练什么、怎么玩、难度如何），' +
      '用 edit_meta 写入 meta.description；标题若仍是「未命名关卡」则一并起一个贴切的名字。',
  },
]
