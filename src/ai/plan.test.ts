/** 计划解析与状态（plan-act 工作流） */
import { describe, expect, it } from 'vitest'
import { buildPlan, parsePlanItems, planProgress } from './plan'

describe('parsePlanItems', () => {
  it('编号/顿号/括号/短横线清单均可解析，剥离勾选前缀', () => {
    expect(parsePlanItems('1. 甲\n2. 乙')).toEqual(['甲', '乙'])
    expect(parsePlanItems('1、甲\n2、乙')).toEqual(['甲', '乙'])
    expect(parsePlanItems('1) 甲\n2) 乙')).toEqual(['甲', '乙'])
    expect(parsePlanItems('- 甲\n* 乙')).toEqual(['甲', '乙'])
    expect(parsePlanItems('  1. [ ] 缩进+勾选')).toEqual(['缩进+勾选'])
  })

  it('非清单行忽略', () => {
    expect(parsePlanItems('导语：目标\n1. 甲\n说明文字没有序号\n\n2. 乙')).toEqual(['甲', '乙'])
    expect(parsePlanItems('没有清单')).toEqual([])
  })
})

describe('buildPlan / planProgress', () => {
  it('无清单项返回 null', () => {
    expect(buildPlan('没有清单')).toBeNull()
  })

  it('构建计划：全部 pending/enabled；进度统计含 skipped', () => {
    const plan = buildPlan('1. 甲\n2. 乙\n3. 丙')!
    expect(plan.status).toBe('draft')
    expect(plan.items).toHaveLength(3)
    expect(plan.items.every((i) => i.status === 'pending' && i.enabled)).toBe(true)
    expect(planProgress(plan)).toEqual({ done: 0, total: 3 })
    plan.items[0].status = 'done'
    plan.items[1].status = 'skipped'
    expect(planProgress(plan)).toEqual({ done: 2, total: 3 })
  })
})
