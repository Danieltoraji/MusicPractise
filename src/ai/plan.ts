/**
 * AI 计划（plan）类型（W9）：v4 AI 面板只有 ask/agent 两模式，不再提供 plan-act 执行器；
 * `ai/session.ts` 的持久化记录仍保留 plan 字段用于历史记录清洗/兼容，故保留形状定义。
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
