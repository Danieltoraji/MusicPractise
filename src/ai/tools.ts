/**
 * AI 工具注册表（批次1：只读五件套）。
 * 工具是 agent 循环的手：模型通过 function calling 请求调用，
 * exec 在本地执行并返回文本结果回填给模型。写入类工具批次2 再放行。
 * 只依赖 engine/library/runtime 层，保持 src/ai 编辑器无关。
 */

import { lintGraphProgramDetailed, type GraphLintCtx } from '../engine/graphProgram'
import type { LevelDoc } from '../engine/level'
import type { Json } from '../engine/expr'
import { loadLevelDoc } from '../library/validate'
import { readRunLog } from '../runtime/runLog'
import { getDef } from '../runtime/store'
import { generateScript } from '../engine/script'
import { describeGNode, LIFECYCLE_CATALOG, clipContractText } from './prompts'
import { formatRunReport, runLevelHeadless, type RunEventStep } from './runHarness'
import { setAiHighlight } from '../editor/graph/aiHighlight'

export interface ToolContext {
  /** 读最新 doc（经 ref 转发，跨轮次看到其它工具/用户的修改） */
  getDoc(): LevelDoc
  /** 应用修改后的 doc（走编辑器唯一写路径 update → 全视图自动刷新+标脏）；写入工具专用 */
  applyDoc(next: LevelDoc): void
  /**
   * 编辑器文档修订号（F1，docs/42 §4.3）：每次文档变更递增。
   * agent 循环据此检测运行期间创作者的手动编辑——写入前修订号与上次 AI 写入后的不一致时
   * 拒绝写入（要求模型先重读现状），避免整文档回写静默覆盖用户改动。
   */
  getRevision?(): number
  /** 运行日志按关卡 id 存取 */
  levelId: string
  /**
   * 截取工作台屏幕（返回 PNG data URL；不支持时返回 null）——AI 截图工具用。
   * target：graph=节点图画布（默认）；canvas=编辑器画布的关卡预览（节点图视图下无此元素返回 null）；
   * debug=调试运行的游玩画面（无可见调试会话时返回 null）
   */
  captureScreenshot?(target?: 'graph' | 'canvas' | 'debug'): Promise<string | null>
  /** 向对话追加图像（多模态模型可查看、创作者可见）——AI 截图后调用 */
  emitImages?(images: string[]): void
  /**
   * 运行中止信号（docs/40 F5/C4）：面板卸载/用户停止时 abort——长等待类工具
   * （debug_dispatch 剧本等）在每个等待点检查后提前收尾，不再「停止后仍跑完并落盘」
   */
  signal?: AbortSignal
}

export interface AiTool {
  name: string
  description: string
  /** JSON Schema parameters */
  parameters: Record<string, unknown>
  exec(args: Record<string, unknown>, ctx: ToolContext): string | Promise<string>
}

const readScriptTool: AiTool = {
  name: 'read_script',
  description: '读取当前关卡的逻辑伪代码（LevelScript——节点图的文本投影，on 事件处理器/赋值/调用/if/while 等）',
  parameters: { type: 'object', properties: {} },
  exec: (_args, ctx) => {
    const logic = ctx.getDoc().content.logic
    try {
      return generateScript(logic)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const list = logic.nodes.map((n) => `- ${n.id}: ${describeGNode(n)}`).join('\n')
      return `图超出伪代码结构化子集（${reason}）。改为节点清单：\n${list}`
    }
  },
}

const MAX_DOC_CHARS = 8000
const MAX_ROWS = 10
/** F18/F19：read_doc 分段名唯一来源（工具 schema enum 由此派生） */
const READ_DOC_PARTS = ['all', 'meta', 'components', 'table', 'flow'] as const

/**
 * F18（docs/44 R16）：单段超长时优先在行边界截断，并明确提示「可分段读取」——
 * 此前整篇 8000 字硬截断会把后面的段落（数据表/推进配置/逻辑概要）静默丢掉。
 */
function clipDocSection(name: string, text: string, budget: number): string {
  if (text.length <= budget) return text
  const hint = `\n…（${name} 段超长已截断，可 read_doc part=${name} 或 read_json 查看原始内容）`
  const room = Math.max(0, budget - hint.length)
  let head = text.slice(0, room)
  const nl = head.lastIndexOf('\n')
  if (nl > room * 0.6) head = head.slice(0, nl)
  return head + hint
}

const readDocTool: AiTool = {
  name: 'read_doc',
  description:
    '读取关卡文档的结构化摘要（meta/视图/组件/变量/数据表/推进配置）。' +
    '组件段附每个组件的事件/命令/查询契约与 props 字段（name/type/options/default，写入逻辑与改 props 前以此为准，不要臆测事件名）；' +
    '另附生命周期事件目录（level.started/level.finished/question.loaded/view.entered 及 payload）。看逻辑用 read_script，看原始 JSON 用 read_json。' +
    '全文超长会按段截断并提示可 read_doc part=… 分段读取',
  parameters: {
    type: 'object',
    properties: {
      part: { type: 'string', enum: [...READ_DOC_PARTS], description: '只看某一节，默认 all' },
    },
  },
  exec: (args, ctx) => {
    const doc = ctx.getDoc()
    const part = typeof args.part === 'string' ? args.part : 'all'
    const content = doc.content
    /** 段优先级：0=必留（meta/logic 概要）；1=契约/核心（components/lifecycle）；2=次要（table/flow） */
    const sections: { name: string; text: string; priority: number }[] = []

    if (part === 'all' || part === 'meta') {
      sections.push({ name: 'meta', text: `## meta\n${JSON.stringify(doc.meta, null, 2)}`, priority: 0 })
    }
    if (part === 'all' || part === 'components') {
      const comps = content.components.map((c) => {
        // 契约清单随读随取：运行中途新增的组件（如 agent 刚批量添加的）也能立刻被模型看到事件/命令
        let events: string[] = []
        let commands: string[] = []
        let queries: string[] = []
        let propsDoc: string | undefined
        let propsFields: { name: string; type: string; options?: string[]; default?: Json }[] = []
        try {
          const def = getDef(c.type)
          // F3：下发「键(负载说明)」值——只给键名曾让模型猜错 payload 形状静默无效
          events = Object.entries(def.contract.events).map(([k, v]) => `${k}(${clipContractText(v)})`)
          commands = Object.entries(def.contract.commands).map(([k, v]) => `${k}(${clipContractText(v)})`)
          queries = Object.entries(def.contract.queries ?? {}).map(([k, v]) => `${k}(${clipContractText(v)})`)
          // F3（docs/42 §5.1）：props 契约此前完全缺失——结构化字段给 name/type/options/default，
          // 自由说明给 propsDoc（单条截断防长文本把 read_doc 撑爆）
          propsDoc = def.contract.propsDoc ? clipContractText(def.contract.propsDoc) : undefined
          propsFields = (def.contract.propsFields ?? []).map((f) => ({
            name: f.key,
            type: f.type,
            ...(f.options && f.options.length > 0 ? { options: f.options } : {}),
            ...(f.fallback !== undefined ? { default: f.fallback } : {}),
          }))
        } catch {
          // 未知/旧数据类型：跳过契约段，不阻断读取
        }
        return {
          id: c.id,
          type: c.type,
          name: c.name,
          view: c.view,
          visible: c.visible,
          layout: c.layout,
          props: c.props,
          ...(events.length > 0 ? { events } : {}),
          ...(commands.length > 0 ? { commands } : {}),
          ...(queries.length > 0 ? { queries } : {}),
          ...(propsDoc ? { propsDoc } : {}),
          ...(propsFields.length > 0 ? { propsFields } : {}),
        }
      })
      sections.push({ name: 'components', text: `## components（${comps.length} 个）\n${JSON.stringify(comps, null, 2)}`, priority: 1 })
      // 生命周期事件目录（F3 缺口）：on 入口可用的事件名与 payload，从零写逻辑不用猜
      sections.push({ name: 'lifecycle', text: `## 生命周期事件（on 入口可用）\n${LIFECYCLE_CATALOG}`, priority: 1 })
    }
    if (part === 'all' || part === 'table') {
      const rows = content.table.rows.slice(0, MAX_ROWS)
      const more = content.table.rows.length > MAX_ROWS ? `\n…（仅显示前 ${MAX_ROWS} 行，共 ${content.table.rows.length} 行）` : ''
      sections.push({
        name: 'table',
        text: `## table\n列: ${JSON.stringify(content.table.columns)}\n行: ${JSON.stringify(rows, null, 2)}${more}`,
        priority: 2,
      })
    }
    if (part === 'all' || part === 'flow') {
      sections.push({ name: 'flow', text: `## flow\n${JSON.stringify(content.flow ?? {}, null, 2)}`, priority: 2 })
    }
    if (part === 'all') {
      sections.push({
        name: 'logic',
        text: `## logic 概要\n${content.logic.nodes.length} 节点 / ${content.logic.edges.length} 连线；事件入口: ${
          content.logic.nodes
            .filter((n) => n.kind === 'on')
            .map((n) => (n as { event: string }).event)
            .join('、') || '无'
        }`,
        priority: 0,
      })
    }

    const joined = sections.map((s) => s.text).join('\n\n')
    if (joined.length <= MAX_DOC_CHARS) return joined

    // 单段读取：只裁这一段，并提示分段/原始 JSON
    if (sections.length === 1) return clipDocSection(sections[0].name, sections[0].text, MAX_DOC_CHARS)

    // 全文超预算：必留段先占预算；components 优先给足并在超限时截断；table/flow 可省略并提示
    const reservedHint = 220
    const mandatoryLen = sections
      .filter((s) => s.priority === 0)
      .reduce((n, s, i) => n + s.text.length + (i > 0 ? 2 : 0), 0)
    let budget = Math.max(0, MAX_DOC_CHARS - reservedHint - mandatoryLen)
    const kept: string[] = []
    const incomplete: string[] = []
    for (const sec of sections) {
      if (sec.priority === 0) {
        kept.push(sec.text)
        continue
      }
      const sep = kept.length > 0 ? 2 : 0
      const cost = sep + sec.text.length
      if (cost <= budget) {
        kept.push(sec.text)
        budget -= cost
        continue
      }
      incomplete.push(sec.name)
      // components 是契约核心：宁可截断也给一部分；table/flow 直接省略，靠分段读取
      if (sec.priority === 1 && budget > 320) {
        kept.push(clipDocSection(sec.name, sec.text, Math.max(0, budget - sep)))
        budget = 0
      }
    }
    if (incomplete.length > 0) {
      kept.push(
        `## 分段读取\n全文超出 ${MAX_DOC_CHARS} 字预算，已省略/截断：${incomplete
          .map((n) => `\`read_doc part=${n}\``)
          .join(' / ')}（也可用 read_json 获取完整 JSON）`,
      )
    }
    return kept.join('\n\n')
  },
}

const MAX_JSON_CHARS = 16000

const readJsonTool: AiTool = {
  name: 'read_json',
  description: '读取关卡完整 JSON（逻辑图为节点/边数组形态）。内容很长，优先用 read_script / read_doc',
  parameters: { type: 'object', properties: {} },
  exec: (_args, ctx) => {
    const text = JSON.stringify(ctx.getDoc(), null, 2)
    return text.length > MAX_JSON_CHARS ? `${text.slice(0, MAX_JSON_CHARS)}\n…（已截断于 ${MAX_JSON_CHARS} 字符）` : text
  },
}

const lintTool: AiTool = {
  name: 'lint',
  description: '对当前关卡做静态校验：schema 装载校验（loadLevelDoc）+ 节点图 lint（悬空引用/类型不匹配/端口等），返回全部问题',
  parameters: { type: 'object', properties: {} },
  exec: (_args, ctx) => {
    const doc = ctx.getDoc()
    const lines: string[] = []
    const result = loadLevelDoc(structuredClone(doc))
    if (!result.ok) {
      lines.push('【装载/schema 校验失败】', ...result.errors.map((e) => `- ${e}`))
    } else {
      lines.push(
        result.lintWarnings.length > 0
          ? `【装载校验通过，含 ${result.lintWarnings.length} 条警告】${result.lintWarnings.join('；')}`
          : '【装载校验通过，无警告】',
      )
    }
    const ctxLint: GraphLintCtx = {
      componentIds: doc.content.components.map((c) => c.id),
      componentTypes: Object.fromEntries(doc.content.components.map((c) => [c.id, c.type])),
      viewIds: doc.content.views.map((v) => v.id),
      tableColumns: doc.content.table.columns,
    }
    const issues = lintGraphProgramDetailed(doc.content.logic, ctxLint)
    if (issues.length === 0) {
      lines.push('【图 lint】无问题')
    } else {
      lines.push(`【图 lint】${issues.length} 条：`)
      for (const issue of issues.slice(0, 30)) {
        lines.push(
          `- [${issue.code}]${issue.nodeId ? ` 节点 ${issue.nodeId}` : ''}${issue.field ? ` ${issue.field}:` : ''} ${issue.message}`,
        )
      }
      if (issues.length > 30) lines.push(`…（其余 ${issues.length - 30} 条略）`)
    }
    return lines.join('\n')
  },
}

const MAX_LOG_ENTRIES = 30

const readRunLogTool: AiTool = {
  name: 'read_run_log',
  description: '读取最近一次「▶ 试运行」的运行日志（命令轨迹与错误，错误带节点 id）。没有日志说明还没试运行过',
  parameters: { type: 'object', properties: {} },
  exec: (_args, ctx) => {
    const log = readRunLog(ctx.levelId)
    if (log.length === 0) return '暂无试运行日志——用户还没有在编辑器点「▶ 试运行」运行过此关卡。'
    const tail = log.slice(-MAX_LOG_ENTRIES)
    const lines = tail.map((e) =>
      e.kind === 'error'
        ? `- [错误]${e.nodeId ? `(节点 ${e.nodeId})` : ''}${e.event ? `[${e.event}]` : ''} ${e.message ?? ''}`
        : `- [命令] ${e.path ?? ''}`,
    )
    if (log.length > MAX_LOG_ENTRIES) lines.unshift(`（仅显示最近 ${MAX_LOG_ENTRIES} 条，共 ${log.length} 条）`)
    return lines.join('\n')
  },
}

/** 无头试运行（批次3）：不修改 doc，属诊断——全模式可用 */
const runLevelTool: AiTool = {
  name: 'run_level',
  description:
    '无头试运行当前关卡（不打开游玩页）：自动跑 level.started/question.loaded 等启动流程，' +
    '可注入 events 模拟用户操作（如 {event:"button1.clicked"} 或 {event:"keys1.keyClicked",payload:{midi:60},waitMs:300}），' +
    '返回视图/行轨迹、运行错误（带节点 id）、结算结果与变量终态。修改逻辑/数据后建议跑一次验证',
  parameters: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        description: '依次注入的组件事件剧本（可选）。每步 {event, payload?, waitMs?}；waitMs 默认 120ms',
      },
      timeoutMs: { type: 'number', description: '总超时毫秒（默认 5000，超时说明有卡死风险）' },
    },
  },
  exec: async (args, ctx) => {
    const events = Array.isArray(args.events)
      ? (args.events as Record<string, unknown>[]).map((e) => ({
          event: typeof e.event === 'string' ? e.event : '',
          payload: (e.payload ?? {}) as Json,
          waitMs: typeof e.waitMs === 'number' ? e.waitMs : undefined,
        }))
      : []
    for (const step of events) {
      if (!step.event) return '修改失败（未应用）：events 中存在缺少 event 字段的步骤'
    }
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
    const report = await runLevelHeadless(ctx.getDoc(), {
      events: events as RunEventStep[],
      timeoutMs,
    })
    // 无命中对照（引擎对无处理器事件静默 no-op，只能静态比对 on 事件入口）
    const onEvents = new Set(
      ctx.getDoc().content.logic.nodes.filter((n) => n.kind === 'on').map((n) => (n as { event: string }).event),
    )
    const unmatchedEvents = [...new Set(events.map((e) => e.event))].filter((ev) => !onEvents.has(ev))
    // F12（docs/42 §5.1）：报告里的超时阈值用本次实际 timeoutMs，不再写死 >5000ms
    return formatRunReport(report, { events: events as RunEventStep[], unmatchedEvents, timeoutMs })
  },
}

/** 只读工具集：ask 模式（以及后续 plan 模式）可用 */
/** 节点高亮（批次5）：AI 与创作者的交互——指认正在讨论的节点（发光标记+画布自动定位） */
const highlightNodesTool: AiTool = {
  name: 'highlight_nodes',
  description:
    '在节点图上高亮指定节点（创作者可见的发光标记，画布自动定位到第一个节点）——用于指认你正在讨论/修改的节点。' +
    '再次调用即替换高亮；nodeIds 传空数组清除全部高亮',
  parameters: {
    type: 'object',
    properties: {
      nodeIds: { type: 'array', items: { type: 'string' }, description: '要高亮的节点 id（先 read_script 确认）' },
      note: { type: 'string', description: '一句话说明为什么高亮（显示给创作者）' },
    },
    required: ['nodeIds'],
  },
  exec: (args, ctx) => {
    const ids = Array.isArray(args.nodeIds) ? (args.nodeIds as unknown[]).map((x) => str0(x)).filter((x) => x !== '') : []
    const known = new Set(ctx.getDoc().content.logic.nodes.map((n) => n.id))
    const valid = ids.filter((i) => known.has(i))
    const unknown = ids.filter((i) => !known.has(i))
    if (ids.length > 0 && valid.length === 0) {
      return `高亮失败：节点 id 都不存在。可用节点：${[...known].join('、')}`
    }
    const note = str0(args.note)
    setAiHighlight(valid, note || null)
    return `✓ 已高亮 ${valid.join('、') || '（已清除）'}${unknown.length > 0 ? `（未知 id 已忽略：${unknown.join('、')}）` : ''}${
      note ? ` —— ${note}` : ''
    }`
  },
}
function str0(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 屏幕截图（批次8b/9）：三目标——节点图结构 / 编辑器画布预览 / 调试运行画面；全模式可用 */
const captureScreenTool: AiTool = {
  name: 'capture_screen',
  description:
    '截屏给创作者看并附带给你（多模态模型可直接查看图片）：' +
    'target=graph 截节点图画布（确认图结构/向创作者指认位置）；' +
    'target=canvas 截编辑器画布的关卡预览（组件布局与关卡外观，检查样式问题）；' +
    'target=debug 截调试运行的游玩画面（AI 试玩/断点状态的可见证据，需调试会话在跑）。' +
    '图片同时展示在对话中',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['graph', 'canvas', 'debug'],
        description: 'graph=节点图（默认）；canvas=关卡预览画布；debug=调试运行画面',
      },
    },
  },
  exec: async (args, ctx) => {
    if (!ctx.captureScreenshot || !ctx.emitImages) return '当前环境不支持截图'
    const raw = str0(args.target)
    const target = raw === 'canvas' || raw === 'debug' ? raw : 'graph'
    const dataUrl = await ctx.captureScreenshot(target)
    if (!dataUrl) {
      if (target === 'canvas') return '画布截图失败：当前视图没有关卡画布（例如正处于节点图视图）——切到画布/布局视图再试，或改用 target=graph'
      if (target === 'debug') return '调试画面截图失败：没有可见的调试会话——先用 debug_control(action="start") 启动调试，或改用 target=graph'
      return '截图失败：节点图元素不可用'
    }
    const label = target === 'canvas' ? '关卡画布' : target === 'debug' ? '调试画面' : '节点图'
    ctx.emitImages([dataUrl])
    return `✓ ${label}截图已捕获（附在对话中，创作者可见；若模型支持图像输入则可直接查看）。`
  },
}

export const READONLY_TOOLS: AiTool[] = [
  readScriptTool,
  readDocTool,
  readJsonTool,
  lintTool,
  readRunLogTool,
  runLevelTool,
  highlightNodesTool,
  captureScreenTool,
]
