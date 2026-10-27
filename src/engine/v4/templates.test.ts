/**
 * 零代码模板测试（docs/52 §4 W8.2；docs/51 §3.6；docs/53 §14「零代码模板」）。
 *
 * 覆盖：
 * ① 目录与创建入口：4 个模板、未知 id 中文报错、每次创建新 id、options 覆盖；
 * ② 产物合法性：4 模板全部通过 v4 schema + 结构校验 + lint，且 `lintWarnings = []`；
 * ③ 流程来自预设「印章」：sequence 模板 flow 内可见 `ps_sequence_grade_settle_*` 普通节点，
 *    tutorial 可见 `ps_settle_then_replay_*` 节点（展开即可改，不是隐藏运行时）；
 * ④ 无头通关：blank / listen-choice / rhythm-tap 全对通关；tutorial 固定 3 步 → 结算 →
 *    停在「再学一遍」waitShell，点按钮后 restart；
 * ⑤ 改数据不改图：给 listen-choice 模板加一行数据 → 流程图零修改仍通关（模板的核心承诺）。
 */
import { describe, expect, it } from 'vitest'
import type { Json } from '../expr'
import { loadLevelDocV4 } from '../../library/validate'
import { allContracts } from '../../runtime/store'
import { runLevelHeadless, type HarnessStep, type HarnessReport } from '../../runtime/v4/harness'
import { buildDeck } from './manifest'
import { cloneLevelDocV4, getRow, getTable, getType, type DeckItem, type LevelDocV4 } from './model'
import { validateLevelDocV4 } from './validate'
import { lintLevelDocV4 } from './lint'
import { LEVEL_TEMPLATES, createLevelFromTemplate, getLevelTemplate } from './templates'

const CONTRACT_BY_TYPE = new Map(allContracts().map((contract) => [contract.type, contract]))
const contractOf = (componentType: string) => CONTRACT_BY_TYPE.get(componentType)

const LEVEL_ID_RE = /^res_[0-9A-HJKMNP-TV-Z]{26}$/

// ---------------------------------------------------------------------------
// 装载 / 无头剧本助手（与样例测试同口径）
// ---------------------------------------------------------------------------

function expectTemplateLoadable(doc: LevelDocV4): LevelDocV4 {
  const validation = validateLevelDocV4(doc)
  expect(validation.errors.map((issue) => issue.message)).toEqual([])
  const loaded = loadLevelDocV4(doc)
  expect(loaded.ok, loaded.ok ? '' : loaded.errors.join(' / ')).toBe(true)
  if (!loaded.ok) throw new Error('模板装载失败')
  expect(loaded.lintWarnings).toEqual([])
  expect(loaded.doc.content.types.length).toBeGreaterThan(0)
  const typeIds = loaded.doc.content.types.map((type) => type.id).sort()
  expect(Object.keys(loaded.doc.content.tables).sort()).toEqual(typeIds)
  const starts = loaded.doc.content.flow.nodes.filter((node) => node.kind === 'start')
  expect(starts).toHaveLength(1)
  const finishes = loaded.doc.content.flow.nodes.filter((node) => node.kind === 'finish')
  expect(finishes.length).toBeGreaterThanOrEqual(1)
  expect(lintLevelDocV4(loaded.doc, { contractOf }).filter((issue) => issue.level === 'error')).toEqual([])
  return loaded.doc
}

function surfaceStep(component: string, event: string, payload?: Json): HarnessStep {
  return { when: 'surface', action: { kind: 'surface', component, event, payload } }
}

function shellStep(component: string, event: string): HarnessStep {
  return { when: 'shellWait', action: { kind: 'shell', component, event } }
}

function settleStep(): HarnessStep {
  return { when: 'immediate', action: { kind: 'wait', ms: 1 } }
}

function act(component: string, event: string, payload?: Json): HarnessStep[] {
  return [surfaceStep(component, event, payload), settleStep()]
}

function rowOf(doc: LevelDocV4, item: DeckItem): Record<string, Json> {
  const row = getRow(doc, item.type, item.row)
  expect(row, `行 ${item.type}/${item.row} 不存在`).toBeTruthy()
  return row as unknown as Record<string, Json>
}

/** 按题型生成「全对」剧本（模板使用的内置题型） */
function answerSteps(doc: LevelDocV4, item: DeckItem): HarnessStep[] {
  const row = rowOf(doc, item)
  switch (item.type) {
    case 'choice':
      return act('choice1', 'chosen', { index: row.answerIndex })
    case 'choice-listen':
      return [...act('choice1', 'chosen', { index: row.answerIndex, value: row.answer }), ...act('nextBtn', 'clicked')]
    case 'button-step':
      return act('tryBtn', 'clicked')
    case 'slider-step':
      return [...act('slider1', 'changed', { value: (row.target as number | undefined) ?? 42 }), ...act('nextBtn', 'clicked')]
    case 'rhythm-tap': {
      const grid = row.grid as Json[]
      return [
        ...grid.map((t) => surfaceStep('rhythm1', 'tap', { t })),
        settleStep(),
        surfaceStep('rhythm1', 'roundDone', { duration: 8 }),
        settleStep(),
      ]
    }
    case 'step-choice': {
      return [
        ...act('startBtn', 'clicked'),
        ...act('choice1', 'chosen', { index: row.answerIndex }),
        ...act('nextBtn', 'clicked'),
      ]
    }
    default:
      throw new Error(`模板测试未覆盖题型 ${item.type}`)
  }
}

function answerScript(doc: LevelDocV4, deck: DeckItem[]): HarnessStep[] {
  return deck.flatMap((item) => answerSteps(doc, item))
}

function play(doc: LevelDocV4, script: HarnessStep[], timeoutMs = 3000): Promise<HarnessReport> {
  return runLevelHeadless(doc, { script, timeoutMs })
}

function expectNoErrors(report: HarnessReport): void {
  const errors = report.logs.filter((event) => event.kind === 'error')
  expect(errors, errors.map((event) => event.message).join(' / ')).toEqual([])
}

// ---------------------------------------------------------------------------
// ① 目录与创建入口
// ---------------------------------------------------------------------------

describe('零代码模板目录', () => {
  it('提供 blank / listen-choice / rhythm-tap / tutorial / step-clock 五个模板，未知 id 报中文错误', () => {
    expect(LEVEL_TEMPLATES.map((template) => template.id)).toEqual([
      'blank',
      'listen-choice',
      'rhythm-tap',
      'tutorial',
      'step-clock',
    ])
    for (const template of LEVEL_TEMPLATES) {
      expect(template.name.trim()).not.toBe('')
      expect(template.description.trim()).not.toBe('')
      expect(template.tags.length).toBeGreaterThan(0)
      expect(getLevelTemplate(template.id)).toBe(template)
    }
    expect(getLevelTemplate('nope')).toBeUndefined()
    expect(() => createLevelFromTemplate('nope')).toThrow(/未知关卡模板/)
  })

  it('每次创建新关卡 id；options 可覆盖 id/title；产物是普通 LevelDocV4（无模板隐藏元数据）', () => {
    for (const template of LEVEL_TEMPLATES) {
      const first = createLevelFromTemplate(template.id)
      const second = createLevelFromTemplate(template.id)
      expect(first.id).toMatch(LEVEL_ID_RE)
      expect(second.id).toMatch(LEVEL_ID_RE)
      expect(first.id).not.toBe(second.id)
      expect(JSON.stringify(first)).not.toContain('"template"')
      const overridden = createLevelFromTemplate(template.id, { id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A9', title: '自定义标题' })
      expect(overridden.id).toBe('res_01J9A0A0A0A0A0A0A0A0A0A0A9')
      expect(overridden.meta.title).toBe('自定义标题')
      expect(overridden.version).toBe('0.1.0')
    }
  })
})

// ---------------------------------------------------------------------------
// ② 产物合法性 + ③ 预设印章节点可见
// ---------------------------------------------------------------------------

describe('模板产物：schema + lint 全绿，流程由预设节点组构成', () => {
  for (const template of LEVEL_TEMPLATES) {
    it(`${template.name}：loadLevelDocV4 通过、lintWarnings=[]，流程含可见预设节点组`, () => {
      const doc = expectTemplateLoadable(createLevelFromTemplate(template.id))
      const flowNodeIds = doc.content.flow.nodes.map((node) => node.id)
      // 预设展开为普通节点（id 前缀 ps_<预设>_<实例>_…），作者可在图工作台直接改
      expect(flowNodeIds.some((id) => id.startsWith('ps_'))).toBe(true)
      if (template.id === 'tutorial') {
        expect(flowNodeIds.some((id) => id.startsWith('ps_settle_then_replay_'))).toBe(true)
        expect(flowNodeIds.filter((id) => id.startsWith('ps_sequence_grade_settle_'))).toEqual([])
      } else {
        expect(flowNodeIds.some((id) => id.startsWith('ps_sequence_grade_settle_'))).toBe(true)
      }
      // 流程需要 v.score（finish 从 v.score 读结算分）——由预设声明自动补齐
      expect((doc.content.flow.vars ?? []).some((field) => field.key === 'score')).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// ④ 无头通关
// ---------------------------------------------------------------------------

describe('模板无头通关', () => {
  it('blank：答对 1 题 → 10 分通关', async () => {
    const doc = expectTemplateLoadable(createLevelFromTemplate('blank'))
    const deck = buildDeck(doc).deck
    expect(deck).toHaveLength(1)
    const report = await play(doc, answerScript(doc, deck))
    expect(report.error).toBeUndefined()
    expect(report.finished).toBe(true)
    expect(report.questions).toHaveLength(1)
    expect(report.result).toEqual({ score: 10, passed: true })
    expect(report.logs.some((event) => event.kind === 'finish')).toBe(true)
    expectNoErrors(report)
  })

  it('listen-choice：2 道听音全对 → 20 分通关（手动下一题）', async () => {
    const doc = expectTemplateLoadable(createLevelFromTemplate('listen-choice'))
    const deck = buildDeck(doc).deck
    expect(deck).toHaveLength(2)
    const report = await play(doc, answerScript(doc, deck))
    expect(report.error).toBeUndefined()
    expect(report.finished).toBe(true)
    expect(report.questions.map((entry) => entry.rowId)).toEqual(deck.map((item) => item.row))
    expect(report.result).toEqual({ score: 20, passed: true })
    for (const entry of report.questions) expect(entry.result.status).toBe('answered')
    expect(report.logs.some((event) => event.kind === 'finish')).toBe(true)
    expectNoErrors(report)
  })

  it('rhythm-tap：2 条节奏按栅格全中 → 20 分通关', async () => {
    const doc = expectTemplateLoadable(createLevelFromTemplate('rhythm-tap'))
    const deck = buildDeck(doc).deck
    expect(deck).toHaveLength(2)
    const report = await play(doc, answerScript(doc, deck), 5000)
    expect(report.error).toBeUndefined()
    expect(report.finished).toBe(true)
    expect(report.questions).toHaveLength(2)
    expect(report.result).toEqual({ score: 20, passed: true })
    expectNoErrors(report)
  })

  it('step-clock（v4.1）：题内两视图 + 全局时钟模板可通关（题面/选项分步切换）', async () => {
    const doc = expectTemplateLoadable(createLevelFromTemplate('step-clock'))
    const type = getType(doc, 'step-choice')
    if (!type) throw new Error('模板缺少 step-choice 题型')
    expect(type.surface.views?.map((view) => view.id)).toEqual(['intro', 'answer'])
    expect(type.surface.initialView).toBe('intro')
    expect(type.surface.components.find((component) => component.id === 'startBtn')?.view).toBe('intro')
    expect(type.surface.components.find((component) => component.id === 'choice1')?.view).toBe('answer')
    expect(type.behavior.nodes.some((node) => node.kind === 'setView' && node.view === 'intro')).toBe(true)
    // 全局时钟：shell 绑定引用 run.elapsedMs（运行期由 session 每 100ms 刷新）
    expect(
      doc.content.shell.components.some((component) =>
        Object.values(component.bindings ?? {}).some((expr) => expr.includes('run.elapsedMs')),
      ),
    ).toBe(true)

    const deck = buildDeck(doc).deck
    expect(deck).toHaveLength(2)
    const report = await play(doc, answerScript(doc, deck))
    expect(report.error).toBeUndefined()
    expect(report.finished).toBe(true)
    expect(report.questions).toHaveLength(2)
    expect(report.result).toEqual({ score: 20, passed: true })
    expectNoErrors(report)
  })

  it('tutorial：固定 3 步 → 只有听音选择计 10 分 → 结算后停在「再学一遍」waitShell；点按钮走 restart', async () => {
    const doc = expectTemplateLoadable(createLevelFromTemplate('tutorial'))
    const deck = buildDeck(doc).deck
    expect(deck).toHaveLength(3) // 3 个题型各 1 行（固定步骤流程按显式 ask 顺序执行）
    const steps: HarnessStep[] = [
      shellStep('startBtn', 'clicked'),
      ...act('tryBtn', 'clicked'),
      ...act('slider1', 'changed', { value: 42 }),
      ...act('nextBtn', 'clicked'),
      ...act('choice1', 'chosen', { index: 2, value: 'Mi' }),
      ...act('nextBtn', 'clicked'),
    ]
    const report = await play(doc, steps, 160)
    expect(report.questions.map((entry) => entry.rowId)).toEqual(['row_button', 'row_slider', 'row_choice'])
    expect(report.result).toEqual({ score: 10, passed: true })
    expect(report.finished).toBe(false) // 结算后 waitShell 等待「再学一遍」= 正常态
    expect(report.logs.some((event) => event.kind === 'finish')).toBe(true)
    expectNoErrors(report)

    const replay = await play(doc, [...steps, shellStep('replayBtn', 'clicked')], 160)
    expect(replay.logs.some((event) => event.kind === 'restart')).toBe(true)
    expectNoErrors(replay)
  })
})

// ---------------------------------------------------------------------------
// ⑤ 改数据不改图（模板核心承诺）
// ---------------------------------------------------------------------------

describe('模板：改数据不需要改流程', () => {
  it('listen-choice 加一行数据 → 流程图零修改，deck+1 且仍可通关', async () => {
    const doc = expectTemplateLoadable(createLevelFromTemplate('listen-choice'))
    const flowBefore = JSON.stringify(doc.content.flow)
    const table = getTable(doc, 'choice-listen')
    const type = getType(doc, 'choice-listen')
    if (!table || !type) throw new Error('模板缺少 choice-listen 题型/表')
    const next = cloneLevelDocV4(doc)
    const nextTable = next.content.tables['choice-listen']
    nextTable.rows.push({
      id: 'row_extra',
      prompt: '新加的一题：第三个音是？',
      options: ['Do', 'Re', 'Mi'],
      answer: 'Mi',
      answerIndex: 2,
      listenNotes: [{ midi: 60 }, { midi: 62 }, { midi: 64 }],
      scoring: 10,
    })
    expect(JSON.stringify(next.content.flow)).toBe(flowBefore)
    const reloaded = expectTemplateLoadable(next)
    const deck = buildDeck(reloaded).deck
    expect(deck).toHaveLength(3)
    const report = await play(reloaded, answerScript(reloaded, deck))
    expect(report.error).toBeUndefined()
    expect(report.finished).toBe(true)
    expect(report.result).toEqual({ score: 30, passed: true })
    expectNoErrors(report)
  })
})
