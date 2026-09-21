/**
 * 新手教程与示例关卡（内置种子）端到端验证：
 * 1) 装载管线（schema + lint 零告警）；2) LevelSession 全流程可玩（视图切换/事件/计分/合成器效果）。
 */
import { describe, expect, it } from 'vitest'
import type { LevelDoc } from '../engine/level'
import type { Json } from '../engine/expr'
import { loadLevelDoc } from '../library/validate'
import { LevelSession, type SessionHost } from '../runtime/levelSession'
import type { Effect } from '../runtime/componentDef'

import tutorialDoc from './tutorial-hello.level.json'
import synthLabDoc from './synth-lab.level.json'

/** GraphEngine 的 dispatch 是 fire-and-forget async：排空微任务等待 drain 完成 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

function loaded(doc: unknown): LevelDoc {
  const r = loadLevelDoc(doc)
  expect(r.ok).toBe(true)
  return (r as { ok: true; doc: LevelDoc }).doc
}

function makeSession(doc: LevelDoc) {
  const effects: Effect[] = []
  const finished: { score: Json; passed: boolean }[] = []
  const host: SessionHost = {
    onRow: () => {},
    onView: () => {},
    onFinished: (r) => finished.push(r),
    runEffects: (efs) => effects.push(...efs),
  }
  const session = new LevelSession(doc, host)
  return { session, effects, finished }
}

describe('教程/示例关卡装载', () => {
  it('两个关卡 schema 合法且 lint 零告警', () => {
    for (const doc of [tutorialDoc, synthLabDoc]) {
      const r = loadLevelDoc(doc)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.lintWarnings).toEqual([])
    }
  })
})

describe('新手引导 · 交互教程（全流程可玩）', () => {
  it('欢迎 → 按钮 → 滑块(42 解锁) → 听音选答(答对计分) → 完成视图', async () => {
    const doc = loaded(tutorialDoc)
    const { session, effects, finished } = makeSession(doc)
    session.start()

    expect(session.currentView).toBe('welcome')
    session.dispatch('start_btn.clicked')
    await flush()
    expect(session.currentView).toBe('step1')

    // 第 1 步：点击按钮 → 反馈出现 + 下一步解锁（button 自带 setEnabled，写 enabled 字段）
    session.dispatch('try_btn.clicked')
    await flush()
    expect((session.store.snapshot('s1_fb').state as { text: string }).text).toContain('按钮事件')
    expect((session.store.snapshot('s1_next').state as { enabled?: boolean }).enabled).toBe(true)
    session.dispatch('s1_next.clicked')
    await flush()
    expect(session.currentView).toBe('step2')

    // 第 2 步：滑块 30 不解锁、42 解锁
    session.dispatch('slider1.changed', { value: 30 })
    await flush()
    expect((session.store.snapshot('s2_fb').state as { text: string }).text).toBe('滑块当前值: 30')
    expect((session.store.snapshot('s2_next').state as { enabled?: boolean }).enabled).toBe(false)
    session.dispatch('slider1.changed', { value: 42 })
    await flush()
    expect((session.store.snapshot('s2_next').state as { enabled?: boolean }).enabled).toBe(true)
    session.dispatch('s2_next.clicked')
    await flush()
    expect(session.currentView).toBe('step3')

    // 第 3 步：播放（合成器效果）→ 答错 → 答对计分
    // options 绑定断言：choice 选项来自数据表 $q.data.options（绑定断了测试即红）
    expect(session.store.snapshot('choice1').state).toMatchObject({ options: ['Do', 'Re', 'Mi'] })
    session.dispatch('play_btn.clicked')
    await flush()
    const synth = effects.find((e) => e.type === 'audio.synth') as Extract<Effect, { type: 'audio.synth' }> | undefined
    expect(synth).toMatchObject({ wave: 'triangle', mode: 'seq' })
    // 音阶参考 + 目标音：Do → Re → Mi（最后的音就是题目）
    expect((synth!.notes as unknown[]).length).toBe(3)
    expect((synth!.notes as unknown[]).at(-1)).toMatchObject({ midi: 64, dur: '2n' })
    session.dispatch('choice1.chosen', { index: 0, value: 'Do' })
    await flush()
    expect((session.store.snapshot('s3_fb').state as { text: string }).text).toContain('不是这个')
    expect((session.store.snapshot('s3_next').state as { enabled?: boolean }).enabled).toBe(false)
    session.dispatch('choice1.chosen', { index: 2, value: 'Mi' })
    await flush()
    expect(session.engine.vars.score).toBe(10)
    // answered 锁：答对后重复派发同一选择不再计分（评审 P1-1 回归）
    session.dispatch('choice1.chosen', { index: 2, value: 'Mi' })
    await flush()
    expect(session.engine.vars.score).toBe(10)
    expect((session.store.snapshot('s3_next').state as { enabled?: boolean }).enabled).toBe(true)

    // 完成：finish → 结算 → 自动切到完成视图
    session.dispatch('s3_next.clicked')
    await flush()
    expect(session.currentView).toBe('done')
    expect((session.store.snapshot('score_label').state as { text: string }).text).toBe('最终得分: 10')
    expect(finished).toEqual([{ score: 10, passed: true }])
  })

  it('完成视图「再学一遍」→ 重开回欢迎视图，分数清零', async () => {
    const doc = loaded(tutorialDoc)
    const { session } = makeSession(doc)
    session.start()
    session.dispatch('start_btn.clicked')
    await flush()
    session.dispatch('try_btn.clicked')
    await flush()
    session.dispatch('s1_next.clicked')
    await flush()
    session.dispatch('s2_next.clicked')
    await flush()
    session.dispatch('s3_next.clicked')
    await flush()
    session.dispatch('again_btn.clicked')
    await flush()
    expect(session.currentView).toBe('welcome')
    expect(session.engine.vars.score).toBe(0)
    expect(session.index).toBe(0)
  })
})

describe('音色实验室 · 合成器示例（数据表驱动）', () => {
  it('行推进刷新音色标签；播放按当前行数据发声；末行结算；重开复位', async () => {
    const { session, effects, finished } = makeSession(loaded(synthLabDoc))
    session.start()
    await flush()

    expect(session.currentView).toBe('lab')
    expect((session.store.snapshot('wave_label').state as { text: string }).text).toBe('正弦 · 柔和')
    expect((session.store.snapshot('progress_label').state as { text: string }).text).toBe('第 1 / 6 个音色 · wave: sine')

    // 播放：按当前行的 wave/notes 发声
    session.dispatch('play_btn.clicked')
    await flush()
    const play1 = effects.at(-1) as Extract<Effect, { type: 'audio.synth' }>
    expect(play1).toMatchObject({ wave: 'sine', mode: 'seq' })
    expect((play1.notes as unknown[]).length).toBe(3)

    // 「下一音色」= question.next：推进题目行，绑定组件随行自动刷新
    session.dispatch('next_btn.clicked')
    await flush()
    expect((session.store.snapshot('wave_label').state as { text: string }).text).toBe('三角 · 木琴')
    session.dispatch('play_btn.clicked')
    await flush()
    expect((effects.at(-1) as Extract<Effect, { type: 'audio.synth' }>).wave).toBe('triangle')

    // 连推到末行：question.next 自动结算 → 完成文案 + 钟琴和弦
    for (let i = 0; i < 5; i++) {
      session.dispatch('next_btn.clicked')
      await flush()
    }
    expect(finished).toHaveLength(1)
    expect((session.store.snapshot('wave_label').state as { text: string }).text).toContain('演示完毕')
    const chord = effects.at(-1) as Extract<Effect, { type: 'audio.synth' }>
    expect(chord).toMatchObject({ wave: 'bell' })
    expect((chord.notes as unknown[]).length).toBe(4)

    // 重开：回到第 1 行 + 标签复位
    session.dispatch('again_btn.clicked')
    await flush()
    expect(session.index).toBe(0)
    expect((session.store.snapshot('wave_label').state as { text: string }).text).toBe('正弦 · 柔和')
  })
})
