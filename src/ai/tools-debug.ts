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
  pauseDebug,
  resumeDebug,
  setDebugBreakpoints,
  setDebugVar,
  startDebugRun,
  stepDebug,
  stopDebugRun,
} from '../editor/graph/debugRun'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

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
    '控制调试会话：action=start 以当前文档启动可暂停的调试运行（先于其它 debug 工具）；' +
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
        const err = await startDebugRun(ctx.getDoc())
        if (err) return `调试启动失败：${err}`
        return `✓ 调试会话已启动。\n${stateSummary()}`
      }
      case 'stop':
        stopDebugRun()
        return '✓ 调试会话已停止。'
      case 'resume':
        resumeDebug()
        await new Promise((r) => setTimeout(r, 60))
        return `✓ 已继续。\n${stateSummary()}`
      case 'step':
        stepDebug()
        await new Promise((r) => setTimeout(r, 60))
        return `✓ 单步执行。\n${stateSummary()}`
      case 'pause':
        pauseDebug()
        await new Promise((r) => setTimeout(r, 60))
        return `✓ 已请求暂停（将在下一个节点边界挂起）。\n${stateSummary()}`
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
  exec: (args) => {
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
  description: '在调试会话中手动触发组件事件（与玩家操作同路径），如 {event:"button1.clicked"} 或 {event:"keys1.keyClicked", payload:{midi:60}}；waitMs 为触发后等待毫秒数（默认 300，让级联走完）',
  parameters: {
    type: 'object',
    properties: {
      event: { type: 'string', description: '组件事件全名（实例id.事件名）' },
      payload: { type: 'object', description: '事件负载' },
      waitMs: { type: 'number' },
    },
    required: ['event'],
  },
  exec: async (args) => {
    const event = str(args.event)
    if (!event) return '触发失败：event 不能为空'
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
  description: '修改调试会话中运行时变量的值（直写引擎变量，立即生效但不触发逻辑——用于强设状态后继续跑）',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      value: { description: '新值（JSON）' },
    },
    required: ['name', 'value'],
  },
  exec: (args) => {
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
  exec: (args) => {
    const ids = Array.isArray(args.nodeIds) ? (args.nodeIds as unknown[]).map(str).filter((x) => x !== '') : []
    setDebugBreakpoints(ids)
    return `✓ 断点已设置：${ids.join('、') || '（空）'}`
  },
}

const debugScreenshotTool: AiTool = {
  name: 'debug_screenshot',
  description: '截取当前节点图画布为屏幕截图：图片会展示给创作者（对话中可见），并附带给多模态模型查看。用于确认图结构、向创作者说明问题位置',
  parameters: { type: 'object', properties: {} },
  exec: async (_args, ctx) => {
    if (!ctx.captureScreenshot || !ctx.emitImages) return '当前环境不支持截图'
    const dataUrl = await ctx.captureScreenshot()
    if (!dataUrl) return '截图失败：画布元素不可用'
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
