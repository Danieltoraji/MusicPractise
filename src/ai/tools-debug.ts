/**
 * AI 调试工具组（批次5）：让 AI 自主驱动 Debug 模式——启动/停止调试会话、
 * 读取状态与实时日志、触发关卡事件、修改变量值、设断点、截取节点图屏幕截图。
 * 全部操作走 debugRun 模块单例（与人类调试面板同一真源，面板实时反映 AI 的操作）。
 * 仅注册于 agent 模式。
 */

import type { Json } from '../engine/expr'
import type { AiTool } from './tools'
import {
  dispatchDebugEvent,
  getDebugSnapshot,
  isDebuggingDoc,
  pauseDebug,
  resumeDebug,
  setDebugBreakpoints,
  setDebugVar,
  startDebugRun,
  stepDebug,
  stopDebugRun,
} from '../editor/graph/debugRun'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

/**
 * 会话归属守卫（docs/40 E4）：调试单例全局只有一个会话——已在运行但不属于本文档时，
 * AI 的读写操作会把 A 关的变量/日志当作 B 关的诊断依据（跨关卡串台）。报错让模型先 stop。
 * mode==='idle' 时放行（后续 start 由调用方决定）；start 另有 E4 残留守卫：
 * 任何非 idle 状态都拒绝（含同文档/人工会话），避免静默 stop 后接管。
 */
function guardDoc(ctx: { levelId: string }): string | null {
  const s = getDebugSnapshot()
  if (s.mode !== 'idle' && !isDebuggingDoc(ctx.levelId)) {
    return `调试会话正在运行另一份文档（${s.owner === 'ai' ? 'AI 启动' : '人工启动'}）——先 stop 再操作本文档，避免跨关卡串台`
  }
  return null
}

function stateSummary(): string {
  const s = getDebugSnapshot()
  const parts = [
    `模式=${s.mode}`,
    `视图=${s.view || '无'}`,
    `题目行=${s.row}/${s.total}`,
    s.pausedAt ? `暂停于节点 ${s.pausedAt}（事件 ${s.pausedEvent ?? ''}）` : '未暂停',
    s.finished ? `已结算 score=${JSON.stringify(s.finished.score)} passed=${s.finished.passed}` : '未结算',
    `变量：${Object.entries(s.vars)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ') || '无'}`,
    `断点：${s.breakpoints.join('、') || '无'}`,
  ]
  return parts.join('\n')
}

const debugControlTool: AiTool = {
  name: 'debug_control',
  description:
    '控制调试会话：action=start 以当前文档启动**可见**调试会话（游玩画面显示在工作台左侧，创作者实时可见你操作的每一步）；' +
    'resume 放行挂起的节点；step 单步（下一节点边界再暂停）；pause 在下一节点边界暂停；stop 停止会话',
  parameters: {
    type: 'object',
    properties: { action: { type: 'string', enum: ['start', 'stop', 'resume', 'step', 'pause'] } },
    required: ['action'],
  },
  exec: async (args, ctx) => {
    const action = str(args.action)
    switch (action) {
      case 'start': {
        // E4 残留（docs/42 §4.4）：startDebugRun 内部会先静默 stop 现有会话——若已有会话在跑，
        // AI 的 start 会接管/停掉人工调试会话且不留痕迹。非 idle 一律拒绝，要求显式 stop。
        const s = getDebugSnapshot()
        if (s.mode !== 'idle') {
          const who = s.owner === 'ai' ? 'AI 启动' : '人工启动'
          return `调试启动失败：已有调试会话在运行（${who}）——先 debug_control(action="stop") 停止后再启动，不能静默重启或接管会话`
        }
        const err = await startDebugRun(ctx.getDoc(), 'ai')
        if (err) return `调试启动失败：${err}`
        return `✓ 调试会话已启动（AI 归属）。\n${stateSummary()}`
      }
      case 'stop': {
        const blocked = guardDoc(ctx)
        if (blocked) return blocked
        stopDebugRun()
        return '✓ 调试会话已停止。'
      }
      case 'resume': {
        const blocked = guardDoc(ctx)
        if (blocked) return blocked
        resumeDebug()
        await new Promise((r) => setTimeout(r, 60))
        return `✓ 已继续。\n${stateSummary()}`
      }
      case 'step': {
        const blocked = guardDoc(ctx)
        if (blocked) return blocked
        stepDebug()
        await new Promise((r) => setTimeout(r, 60))
        return `✓ 单步执行。\n${stateSummary()}`
      }
      case 'pause': {
        const blocked = guardDoc(ctx)
        if (blocked) return blocked
        pauseDebug()
        await new Promise((r) => setTimeout(r, 60))
        return `✓ 已请求暂停（将在下一个节点边界挂起）。\n${stateSummary()}`
      }
      default:
        return `未知 action「${action}」`
    }
  },
}

const debugReadTool: AiTool = {
  name: 'debug_read',
  description: '读取调试会话的实时信息。part=state 返回模式/暂停位置/视图/题目行/变量/结算；part=log 返回最近的实时运行日志（错误带节点 id）',
  parameters: {
    type: 'object',
    properties: {
      part: { type: 'string', enum: ['state', 'log'] },
      tail: { type: 'number', description: 'part=log：最近多少条（默认 20，上限 50）' },
    },
    required: ['part'],
  },
  exec: (args, ctx) => {
    const blocked = guardDoc(ctx)
    if (blocked) return blocked
    const s = getDebugSnapshot()
    if (s.mode === 'idle') return '调试会话未运行——先用 debug_control(action="start") 启动。'
    if (str(args.part) === 'log') {
      const tail = Math.min(Math.max(Number(args.tail) || 20, 1), 50)
      const rows = s.events.slice(-tail)
      if (rows.length === 0) return '实时日志为空（还没有事件流动）。'
      return rows
        .map((e: { kind: string; nodeId?: string; message?: string; path?: string }) =>
          e.kind === 'error' ? `✗ ${e.nodeId ? `[${e.nodeId}] ` : ''}${e.message}` : `· ${e.path}`,
        )
        .join('\n')
    }
    return stateSummary()
  },
}

const debugDispatchTool: AiTool = {
  name: 'debug_dispatch',
  description:
    '在调试会话中手动触发组件事件（与玩家操作同路径），如 {event:"button1.clicked"} 或 {event:"keys1.keyClicked", payload:{midi:60}}；' +
    'waitMs 为触发后等待毫秒数（默认 300，让级联走完，上限 2000）。多步操作（如按键序列）用 events 剧本一次顺序触发多个',
  parameters: {
    type: 'object',
    properties: {
      event: { type: 'string', description: '组件事件全名（实例id.事件名）' },
      payload: { type: 'object', description: '事件负载' },
      waitMs: { type: 'number' },
      events: {
        type: 'array',
        description: '批量剧本：一次顺序触发多个事件 [{event, payload?, waitMs?}]（与单事件参数二选一，多步操作时优先用它）',
        items: {
          type: 'object',
          properties: { event: { type: 'string' }, payload: { type: 'object' }, waitMs: { type: 'number' } },
          required: ['event'],
        },
      },
    },
  },
  exec: async (args, ctx) => {
    const blocked = guardDoc(ctx)
    if (blocked) return blocked
    // 批量剧本形态：顺序触发多个事件（前面的已触发即生效，中断时在错误里说明位置）
    if (Array.isArray(args.events)) {
      const events = (args.events as unknown[]).map(obj)
      if (events.length === 0) return '触发失败：events 不能为空'
      if (events.some((e) => !str(e.event))) return '触发失败：events 中存在空 event'
      const done: string[] = []
      for (const e of events) {
        if (ctx.signal?.aborted) return `已停止：剧本完成 ${done.length}/${events.length}（${done.join(' → ') || '无'}），其余未触发`
        const err = await dispatchDebugEvent(str(e.event), (e.payload ?? {}) as Json)
        if (err) return `剧本第 ${done.length + 1} 个事件（${str(e.event)}）触发失败：${err}（前面 ${done.length} 个已触发）`
        done.push(str(e.event))
        await new Promise((r) => setTimeout(r, Math.min(Number(e.waitMs) || 300, 2000)))
      }
      const s = getDebugSnapshot()
      return `✓ 已按剧本触发 ${done.length} 个事件：${done.join(' → ')}。\n${s.pausedAt ? `⚠ 暂停于节点 ${s.pausedAt}（断点/单步）` : '未暂停'}\n变量：${
        Object.entries(s.vars)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ') || '无'
      }`
    }
    const event = str(args.event)
    if (!event) return '触发失败：event 不能为空（或改用 events 剧本批量触发）'
    if (ctx.signal?.aborted) return '已停止：事件未触发'
    const err = await dispatchDebugEvent(event, (args.payload ?? {}) as Json)
    if (err) return `触发失败：${err}`
    await new Promise((r) => setTimeout(r, Math.min(Number(args.waitMs) || 300, 2000)))
    const s = getDebugSnapshot()
    return `✓ 已触发 ${event}。\n${s.pausedAt ? `⚠ 暂停于节点 ${s.pausedAt}（断点/单步）` : '未暂停'}\n变量：${
      Object.entries(s.vars)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ') || '无'
    }`
  },
}

const debugSetVarTool: AiTool = {
  name: 'debug_set_var',
  description:
    '修改调试会话中运行时变量的值（直写引擎变量，立即生效但不触发逻辑——用于强设状态后继续跑）。多个变量用 vars 一次设置（如 {"vars":{"score":100,"combo":3}}）',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      value: { description: '新值（JSON）' },
      vars: { type: 'object', description: '批量形态：{变量名: 新值}，一次设置多个（与 name/value 二选一，多变量时优先用它）' },
    },
  },
  exec: (args, ctx) => {
    const blocked = guardDoc(ctx)
    if (blocked) return blocked
    // 批量形态：vars 一次设置多个（某个失败时已设置的保留，错误中说明位置）
    if (args.vars !== undefined) {
      const batch = obj(args.vars)
      const names = Object.keys(batch)
      if (names.length === 0) return '赋值失败：vars 不能为空'
      const done: string[] = []
      for (const n of names) {
        const err = setDebugVar(n, (batch[n] ?? 0) as Json)
        if (err) return `赋值失败（${n}）：${err}（已设置保留：${done.join('、') || '无'}）`
        done.push(`${n}=${JSON.stringify(batch[n] ?? 0)}`)
      }
      return `✓ 已设置 ${done.length} 个变量：${done.join('、')}`
    }
    const err = setDebugVar(str(args.name), (args.value ?? 0) as Json)
    if (err) return `赋值失败：${err}`
    return `✓ 变量 ${str(args.name)} 已设为 ${JSON.stringify(args.value ?? 0)}`
  },
}

const debugBreakpointsTool: AiTool = {
  name: 'debug_breakpoints',
  description: '替换调试断点集合（全量设置）：传入节点 id 数组；空数组 = 清空全部断点',
  parameters: {
    type: 'object',
    properties: { nodeIds: { type: 'array', items: { type: 'string' }, description: '节点 id 全集' } },
    required: ['nodeIds'],
  },
  exec: (args, ctx) => {
    const blocked = guardDoc(ctx)
    if (blocked) return blocked
    const ids = Array.isArray(args.nodeIds) ? (args.nodeIds as unknown[]).map(str).filter((x) => x !== '') : []
    setDebugBreakpoints(ids)
    return `✓ 断点已设置：${ids.join('、') || '（空）'}`
  },
}

const debugScreenshotTool: AiTool = {
  name: 'debug_screenshot',
  description:
    '截取当前调试运行的游玩画面（批次9 调试可视化：AI 启动的调试会话在左侧可见，截屏即「看」到断点/试玩状态）；' +
    '无可见调试会话时回落截节点图。图片会展示给创作者（对话中可见），并附带给多模态模型查看',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    if (!ctx.captureScreenshot || !ctx.emitImages) return '当前环境不支持截图'
    // 优先调试画面（可见会话）；截不到（无会话/不在节点图工作台）回落节点图
    const dataUrl = (await ctx.captureScreenshot('debug')) ?? (await ctx.captureScreenshot('graph'))
    if (!dataUrl) return '截图失败：调试画面与节点图均不可用'
    ctx.emitImages([dataUrl])
    return '✓ 屏幕截图已捕获（附在对话中，创作者可见；若模型支持图像输入则可直接查看）。'
  },
}

/** 调试工具集：agent 模式在只读+写入之外追加这组 */
export const DEBUG_TOOLS: AiTool[] = [
  debugControlTool,
  debugReadTool,
  debugDispatchTool,
  debugSetVarTool,
  debugBreakpointsTool,
  debugScreenshotTool,
]
