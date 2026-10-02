/**
 * AI 工具注册表（批次1：只读五件套）。
 * 工具是 agent 循环的手：模型通过 function calling 请求调用，
 * exec 在本地执行并返回文本结果回填给模型。写入类工具批次2 再放行。
 * 只依赖 engine/library/runtime 层，保持 src/ai 编辑器无关。
 */

import { lintGraphProgramDetailed, type GraphLintCtx } from '../engine/graphProgram'
import type { LevelDoc } from '../engine/level'
import { loadLevelDoc } from '../library/validate'
import { readRunLog } from '../runtime/runLog'
import { generateScript } from '../engine/script'
import { describeGNode } from './prompts'

export interface ToolContext {
  /** 读最新 doc（经 ref 转发，跨轮次看到其它工具/用户的修改） */
  getDoc(): LevelDoc
  /** 运行日志按关卡 id 存取 */
  levelId: string
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

const readDocTool: AiTool = {
  name: 'read_doc',
  description: '读取关卡文档的结构化摘要（meta/视图/组件/变量/数据表/推进配置）。看逻辑请用 read_script，看原始 JSON 用 read_json',
  parameters: {
    type: 'object',
    properties: {
      part: { type: 'string', enum: ['all', 'meta', 'components', 'table', 'flow'], description: '只看某一节，默认 all' },
    },
  },
  exec: (args, ctx) => {
    const doc = ctx.getDoc()
    const part = typeof args.part === 'string' ? args.part : 'all'
    const content = doc.content
    const sections: string[] = []

    if (part === 'all' || part === 'meta') {
      sections.push(`## meta\n${JSON.stringify(doc.meta, null, 2)}`)
    }
    if (part === 'all' || part === 'components') {
      const comps = content.components.map((c) => ({
        id: c.id,
        type: c.type,
        name: c.name,
        view: c.view,
        visible: c.visible,
        layout: c.layout,
        props: c.props,
      }))
      sections.push(`## components（${comps.length} 个）\n${JSON.stringify(comps, null, 2)}`)
    }
    if (part === 'all' || part === 'table') {
      const rows = content.table.rows.slice(0, MAX_ROWS)
      const more = content.table.rows.length > MAX_ROWS ? `\n…（仅显示前 ${MAX_ROWS} 行，共 ${content.table.rows.length} 行）` : ''
      sections.push(
        `## table\n列: ${JSON.stringify(content.table.columns)}\n行: ${JSON.stringify(rows, null, 2)}${more}`,
      )
    }
    if (part === 'all' || part === 'flow') {
      sections.push(`## flow\n${JSON.stringify(content.flow ?? {}, null, 2)}`)
    }
    if (part === 'all') {
      sections.push(
        `## logic 概要\n${content.logic.nodes.length} 节点 / ${content.logic.edges.length} 连线；事件入口: ${content.logic.nodes
          .filter((n) => n.kind === 'on')
          .map((n) => (n as { event: string }).event)
          .join('、') || '无'}`,
      )
    }
    const text = sections.join('\n\n')
    return text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n…（已截断）` : text
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

/** 只读工具集：ask 模式（以及后续 plan 模式）可用 */
export const READONLY_TOOLS: AiTool[] = [readScriptTool, readDocTool, readJsonTool, lintTool, readRunLogTool]
