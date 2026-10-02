/**
 * 计划（plan-act 工作流）的结构化模型（docs/28 批次2b 完成）：
 * plan 模式产出编号清单 → parsePlanItems 解析为 PlanItem[] → 用户勾选排除 →
 * 确认后 status='executing' 交 agent 逐项执行，AI 用 update_plan 工具标记各项进度，
 * 全部 done/skipped 即计划完成。纯函数 + 类型，无 React/会话依赖。
 */

export type PlanItemStatus = 'pending' | 'in_progress' | 'done' | 'skipped'

export interface PlanItem {
  text: string
  status: PlanItemStatus
  /** 用户勾选：未勾选的项确认后标记 skipped、不下发执行 */
  enabled: boolean
}

export interface PlanState {
  items: PlanItem[]
  /** 生成计划的原回复（回溯用） */
  raw: string
  status: 'draft' | 'executing' | 'done'
}

/**
 * 从回复文本解析编号清单项：`1. xxx` / `1、xxx` / `1) xxx` / `- xxx`（允许缩进，
 * 自动剥离 `[ ]`/`[x]` 勾选前缀）。无序号行忽略——plan 模式的输出契约保证清单行存在。
 */
export function parsePlanItems(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    // 中文语境序号后常无空格（1、甲）：标记后允许零空白
    const m = line.match(/^\s*(?:\d+[.、)]|[-*+])\s*(.+)$/)
    if (!m) continue
    const item = m[1]
      .trim()
      .replace(/^\[[ xX]\]\s*/, '')
      .trim()
    if (item !== '') out.push(item)
  }
  return out
}

/** 从回复构建计划；解析不出清单项返回 null（调用方回退纯文本执行条） */
export function buildPlan(text: string): PlanState | null {
  const items = parsePlanItems(text)
  if (items.length === 0) return null
  return {
    raw: text,
    status: 'draft',
    items: items.map((t) => ({ text: t, status: 'pending' as const, enabled: true })),
  }
}

export function planProgress(plan: PlanState): { done: number; total: number } {
  const total = plan.items.length
  const done = plan.items.filter((i) => i.status === 'done' || i.status === 'skipped').length
  return { done, total }
}
