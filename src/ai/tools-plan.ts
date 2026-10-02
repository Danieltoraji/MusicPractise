/**
 * 计划进度工具（plan-act 工作流）：agent 执行已确认的计划时，
 * 用 update_plan 逐项标记 in_progress/done/skipped——面板计划卡实时显示进度。
 * 仅在会话存在 executing 状态的计划时注册/生效；直接操作会话 store（notify 驱动面板刷新）。
 */

import { getSession, patchSession } from './session'
import type { AiTool } from './tools'
import type { PlanItemStatus } from './plan'

const STATUS_SET = new Set<string>(['pending', 'in_progress', 'done', 'skipped'])

const updatePlanTool: AiTool = {
  name: 'update_plan',
  description:
    '更新当前执行计划的项进度（逐项标记）。marks 数组：{index: 计划项序号(0 起), status: "in_progress"|"done"|"skipped"}。' +
    '开工某项时标 in_progress、完成后标 done、无法完成标 skipped',
  parameters: {
    type: 'object',
    properties: {
      marks: {
        type: 'array',
        description: '进度标记数组',
      },
    },
    required: ['marks'],
  },
  exec: (args, ctx) => {
    const s = getSession(ctx.levelId)
    if (!s.plan || s.plan.status !== 'executing') return '当前没有执行中的计划（update_plan 不可用）'
    const marks = Array.isArray(args.marks) ? (args.marks as unknown[]) : []
    if (marks.length === 0) return '更新失败：marks 为空'
    let changed = 0
    const applied: string[] = []
    for (const raw of marks) {
      const m = (typeof raw === 'object' && raw !== null ? raw : {}) as { index?: unknown; status?: unknown }
      const i = Number(m.index)
      const st = String(m.status ?? '')
      if (!Number.isInteger(i) || i < 0 || i >= s.plan.items.length) continue
      if (!STATUS_SET.has(st)) continue
      s.plan.items[i].status = st as PlanItemStatus
      applied.push(`${i + 1}.${st}`)
      changed += 1
    }
    if (changed === 0) return '更新失败：没有合法的标记（需 {index, status}）'
    if (s.plan.items.every((it) => it.status === 'done' || it.status === 'skipped')) {
      s.plan.status = 'done'
    }
    // 嵌套对象已原地变更：以新会话对象身份 patch，触发订阅刷新（面板计划卡实时更新）
    patchSession(ctx.levelId, {})
    const progress = s.plan.items
      .map((it, i) => `${i + 1}.${it.status === 'done' ? '✓' : it.status === 'in_progress' ? '→' : it.status === 'skipped' ? '—' : '○'} ${it.text.slice(0, 30)}`)
      .join('\n')
    const done =
      s.plan.status === 'done'
        ? '计划全部完成。'
        : `进度 ${s.plan.items.filter((x) => x.status === 'done' || x.status === 'skipped').length}/${s.plan.items.length}`
    void changed
    return `✓ 进度已更新（${applied.join('、')}）。${done}\n${progress}`
  },
}

export const PLAN_TOOLS: AiTool[] = [updatePlanTool]
