/**
 * v4 内置样例 · 无头通关 golden + 数据变更属性测试（docs/52 W4.4）。
 *
 * 用 `runLevelHeadless` 按剧本注入 surface / shell 事件：
 * - golden：每关全对通关，断言每题结果 / 分数 / 通过状态 / 题数 / 牌堆顺序；
 * - 负向：答错重试、跳过、限时超时、稳定未达标后达标、节奏失败重来等分支；
 * - 属性：加行/删行/重排/草稿翻转/phase/order/显式题单增删/args 变更/shuffle+seed
 *   → **流程图零修改**，loadLevelDocV4 通过、lintWarnings 为空、牌堆与通关结果符合预期。
 */
import { describe, expect, it } from 'vitest'
import type { Json } from '../../engine/expr'
import {
  cloneLevelDocV4,
  getRow,
  getTable,
  getType,
  type DeckItem,
  type LevelDocV4,
  type QuestionRow,
} from '../../engine/v4/model'
import { buildAutoManifest, buildDeck } from '../../engine/v4/manifest'
import { DATA_APPLY_COMMANDS } from '../../engine/level'
import { loadLevelDocV4 } from '../../library/validate'
import { allContracts } from '../../runtime/store'
import { runLevelHeadless, type HarnessReport, type HarnessStep } from '../../runtime/v4/harness'
import { SAMPLE_LEVELS, type SampleLevelSpec } from './levels'

/** 教程按 docs/51 §6 的固定 3 步流程（不遍历题单） */
const TUTORIAL_ASKS: { type: string; row: string }[] = [
  { type: 'button-step', row: 'row_button' },
  { type: 'slider-step', row: 'row_slider' },
  { type: 'choice-listen', row: 'row_choice' },
]

// ---------------------------------------------------------------------------
// 剧本构造：按题型 id 生成「正确作答」事件序列
// ---------------------------------------------------------------------------

function surfaceStep(component: string, event: string, payload?: Json): HarnessStep {
  return { when: 'surface', action: { kind: 'surface', component, event, payload } }
}

function shellStep(component: string, event: string): HarnessStep {
  return { when: 'shellWait', action: { kind: 'shell', component, event } }
}

/** 让流程推进到下一题（等待 session 完成 return → 下一次 ask 挂载） */
function settleStep(ms = 1): HarnessStep {
  return { when: 'immediate', action: { kind: 'wait', ms } }
}

/**
 * 单个 surface 事件 + 事件间排空。
 *
 * 注意：Windows 上 setTimeout(1) 实测 ≈15ms（系统定时器精度），所以只在「下一个事件依赖上一个事件
 * 写入的作用域」时才排空；同一条 handler 内的连续事件（逐音/逐拍/逐次 pitch）靠行为任务 FIFO 顺序，
 * 不需要排空——这样 10 关 × 数据变更矩阵的整体时长才能压进 15s 预算。
 */
function act(component: string, event: string, payload?: Json): HarnessStep[] {
  return [surfaceStep(component, event, payload), settleStep()]
}

function rowOf(doc: LevelDocV4, item: DeckItem): Record<string, Json> {
  const row = getRow(doc, item.type, item.row)
  expect(row, `行 ${item.type}/${item.row} 不存在`).toBeTruthy()
  return row as unknown as Record<string, Json>
}

function answerSteps(doc: LevelDocV4, item: DeckItem): HarnessStep[] {
  const row = rowOf(doc, item)
  switch (item.type) {
    case 'staff-click':
      // 答对写 q.state.answered 后「下一题」才会计分：两步之间必须排空
      return [
        ...act('staff1', 'noteClicked', { midi: row.answerMidi, name: '' }),
        ...act('nextBtn', 'clicked'),
      ]
    case 'choice-listen':
      return [
        ...act('choice1', 'chosen', { index: row.answerIndex, value: row.answer }),
        ...act('nextBtn', 'clicked'),
      ]
    case 'choice-timed':
      return [surfaceStep('choice1', 'chosen', { index: row.answerIndex, value: row.answer }), settleStep()]
    case 'keyboard-melody': {
      const target = row.targetNotes as Json[]
      return [...target.map((midi) => surfaceStep('keys1', 'keyClicked', { midi, name: '' })), settleStep()]
    }
    case 'text-answer':
      return [surfaceStep('input1', 'submitted', { value: row.answer }), settleStep()]
    case 'rhythm-tap': {
      const grid = row.grid as Json[]
      // roundDone 读取 local.taps：必须等全部 tap 事件写入后再判定
      return [
        ...grid.map((t) => surfaceStep('rhythm1', 'tap', { t })),
        settleStep(),
        surfaceStep('rhythm1', 'roundDone', { duration: 8 }),
        settleStep(),
      ]
    }
    case 'tuner-target': {
      const targetMidi = row.targetMidi as number
      const freq = 440 * Math.pow(2, (targetMidi - 69) / 12)
      const need = Math.round((row.stableSeconds as number) * 10)
      return [
        ...Array.from({ length: need }, () =>
          surfaceStep('tuner1', 'pitch', { freq, midi: targetMidi, cents: 0, clarity: 1 }),
        ),
        settleStep(),
      ]
    }
    case 'synth-demo':
      return [surfaceStep('playBtn', 'clicked'), surfaceStep('nextBtn', 'clicked'), settleStep()]
    case 'button-step':
      return [surfaceStep('tryBtn', 'clicked'), settleStep()]
    case 'slider-step':
      return [
        ...act('slider1', 'changed', { value: (row.target as number | undefined) ?? 42 }),
        ...act('nextBtn', 'clicked'),
      ]
    default:
      throw new Error(`answerSteps 未覆盖题型 ${item.type}`)
  }
}

function answerScript(doc: LevelDocV4, deck: DeckItem[]): HarnessStep[] {
  return deck.flatMap((item) => answerSteps(doc, item))
}

function tutorialDeck(doc: LevelDocV4): DeckItem[] {
  return TUTORIAL_ASKS.map((ask, index) => {
    expect(getType(doc, ask.type), `教程题型 ${ask.type} 不存在`).toBeTruthy()
    expect(getRow(doc, ask.type, ask.row), `教程行 ${ask.row} 不存在`).toBeTruthy()
    return { type: ask.type, row: ask.row, slotIndex: index, phase: 1, order: index }
  })
}

function tutorialScript(doc: LevelDocV4): HarnessStep[] {
  return [shellStep('start_btn', 'clicked'), ...answerScript(doc, tutorialDeck(doc))]
}

/** 每行「全对」时该题型应返回的 scoreDelta（与题型行为一致；流程只做 v.score + delta） */
function expectedScoreDelta(doc: LevelDocV4, item: DeckItem): number {
  const row = rowOf(doc, item)
  switch (item.type) {
    case 'button-step':
    case 'slider-step':
    case 'synth-demo':
      return 0
    case 'choice-listen': {
      const bonus = (item.args as Record<string, Json> | undefined)?.bonus
      return (row.scoring as number) + (typeof bonus === 'number' ? bonus : 0)
    }
    default:
      return row.scoring as number
  }
}

function expectedScore(doc: LevelDocV4, deck: DeckItem[]): number {
  return deck.reduce((sum, item) => sum + expectedScoreDelta(doc, item), 0)
}

function loaded(doc: unknown): LevelDocV4 {
  const result = loadLevelDocV4(doc)
  expect(result.ok, result.ok ? '' : result.errors.join(' / ')).toBe(true)
  if (!result.ok) throw new Error('装载失败')
  expect(result.lintWarnings).toEqual([])
  return result.doc
}

function build(spec: SampleLevelSpec): LevelDocV4 {
  return loaded(spec.build())
}

const byFile = new Map(SAMPLE_LEVELS.map((spec) => [spec.file, spec]))
function specOf(file: string): SampleLevelSpec {
  const spec = byFile.get(file)
  if (!spec) throw new Error(`未知样例 ${file}`)
  return spec
}

interface PlayOptions {
  script?: HarnessStep[]
  deck?: DeckItem[]
  timeoutMs?: number
}

function play(doc: LevelDocV4, options: PlayOptions = {}): Promise<HarnessReport> {
  const deck = options.deck ?? buildDeck(doc).deck
  return runLevelHeadless(doc, {
    script: options.script ?? answerScript(doc, deck),
    timeoutMs: options.timeoutMs ?? 2000,
  })
}

function expectNoErrors(report: HarnessReport): void {
  const errors = report.logs.filter((event) => event.kind === 'error')
  expect(errors, errors.map((event) => event.message).join(' / ')).toEqual([])
}

// ---------------------------------------------------------------------------
// golden：9 个「遍历题单」样例全对通关
// ---------------------------------------------------------------------------

describe('v4 内置样例 · 无头通关 golden（遍历题单）', () => {
  for (const spec of SAMPLE_LEVELS.filter((level) => level.flowKind === 'sequence')) {
    it(`${spec.title}：全对通关 → score/passed/questions/deck 符合预期`, async () => {
      const doc = build(spec)
      const deck = buildDeck(doc).deck
      expect(deck).toHaveLength(getTable(doc, spec.typeIds[0])?.rows.length ?? 0)
      const report = await play(doc, { deck })

      expect(report.ok, report.error).toBe(true)
      expect(report.finished).toBe(true)
      expect(report.questions.map((entry) => entry.rowId)).toEqual(deck.map((item) => item.row))
      expect(report.deck).toEqual(deck)
      expect(report.score).toBe(expectedScore(doc, deck))
      expect(report.passed).toBe(expectedScore(doc, deck) >= spec.passScore)
      expect(report.result).toEqual({ score: expectedScore(doc, deck), passed: expectedScore(doc, deck) >= spec.passScore })
      for (const entry of report.questions) {
        expect(entry.result.status).toBe('answered')
        expect(entry.result.correct).toBe(true)
      }
      expect(report.logs.some((event) => event.kind === 'finish')).toBe(true)
      expectNoErrors(report)
    })
  }
})

// ---------------------------------------------------------------------------
// golden：教程（固定 3 步 + 结算后 waitShell / restart）
// ---------------------------------------------------------------------------

describe('v4 内置样例 · 教程特殊流程（docs/51 §6）', () => {
  it('新手引导：固定 3 步全做 → 只有听音选答计 10 分 → 结算后停在 waitShell', async () => {
    const spec = specOf('tutorial-hello.level.json')
    const doc = build(spec)
    const deck = buildDeck(doc).deck
    // 自动题单包含 3 个题型各 1 行；流程按固定顺序 ask（不等同于遍历牌堆）
    expect(deck).toHaveLength(3)
    const report = await play(doc, { script: tutorialScript(doc), timeoutMs: 120 })

    expect(report.questions.map((entry) => entry.rowId)).toEqual(TUTORIAL_ASKS.map((ask) => ask.row))
    expect(report.score).toBe(10)
    expect(report.passed).toBe(true)
    expect(report.result).toEqual({ score: 10, passed: true })
    // 结算后流程等 again_btn（waitShell + restart），此时仍在运行 = 正常的「结算后等待」态
    expect(report.finished).toBe(false)
    expect(report.logs.some((event) => event.kind === 'finish')).toBe(true)
    expectNoErrors(report)
  })

  it('新手引导：结算后点「再学一遍」→ 流程 restart（不是只靠 runner 重玩按钮）', async () => {
    const spec = specOf('tutorial-hello.level.json')
    const doc = build(spec)
    const script = [...tutorialScript(doc), shellStep('again_btn', 'clicked')]
    const report = await play(doc, { script, timeoutMs: 120 })
    expect(report.logs.some((event) => event.kind === 'restart')).toBe(true)
    expectNoErrors(report)
  })
})

// ---------------------------------------------------------------------------
// 题型 / 组件契约覆盖（docs/52 W4.2 / docs/53 §3）
// ---------------------------------------------------------------------------

const EXPECTED_TYPE_IDS = [
  'button-step',
  'choice-listen',
  'choice-timed',
  'keyboard-melody',
  'rhythm-tap',
  'slider-step',
  'staff-click',
  'synth-demo',
  'text-answer',
  'tuner-target',
]

describe('v4 内置样例 · 题型与组件契约覆盖', () => {
  it('10 个内置题型全部被样例使用；surface/shell 组件类型均在组件库注册；绑定槽位合法', () => {
    const registered = new Set(allContracts().map((contract) => contract.type))
    const used = new Set<string>()
    for (const spec of SAMPLE_LEVELS) {
      const doc = build(spec)
      for (const type of doc.content.types) {
        used.add(type.id)
        for (const comp of type.surface.components) {
          expect(
            registered.has(comp.type),
            `题型 ${type.id} 的 surface 组件 ${comp.id} 类型 ${comp.type} 未在组件库注册`,
          ).toBe(true)
          for (const slot of Object.keys(comp.bindings ?? {})) {
            expect(DATA_APPLY_COMMANDS[comp.type]?.[slot], `${comp.id}.${slot} 不是合法绑定槽位`).toBeTruthy()
          }
        }
      }
      for (const comp of doc.content.shell.components) {
        expect(registered.has(comp.type), `shell 组件 ${comp.id} 类型 ${comp.type} 未在组件库注册`).toBe(true)
      }
    }
    expect([...used].sort()).toEqual(EXPECTED_TYPE_IDS)
  })
})

// ---------------------------------------------------------------------------
// 负向：答错重试 / 跳过 / 超时 / 多轮失败
// ---------------------------------------------------------------------------

describe('v4 内置样例 · 负向与重试路径', () => {
  it('听音点击：先点错再点对，首次答对只计一次分', async () => {
    const doc = build(specOf('note-click.level.json'))
    const deck = buildDeck(doc).deck
    const first = deck[0]
    const answer = rowOf(doc, first).answerMidi as number
    const script: HarnessStep[] = [
      ...act('staff1', 'noteClicked', { midi: answer + 1, name: '' }),
      ...act('staff1', 'noteClicked', { midi: answer, name: '' }),
      ...act('nextBtn', 'clicked'),
      ...answerScript(doc, deck.slice(1)),
    ]
    const report = await play(doc, { script })
    expect(report.ok, report.error).toBe(true)
    expect(report.score).toBe(30)
    expect(report.questions[0]?.result).toMatchObject({ correct: true, scoreDelta: 10 })
    expectNoErrors(report)
  })

  it('听音点击：答对前点「下一题」= 跳过（status: skipped，0 分）', async () => {
    const doc = build(specOf('note-click.level.json'))
    const deck = buildDeck(doc).deck
    const script: HarnessStep[] = [
      ...act('nextBtn', 'clicked'),
      ...answerScript(doc, deck.slice(1)),
    ]
    const report = await play(doc, { script })
    expect(report.ok, report.error).toBe(true)
    expect(report.score).toBe(20)
    expect(report.passed).toBe(true)
    expect(report.questions[0]?.result).toMatchObject({ status: 'skipped', correct: false, scoreDelta: 0 })
    expectNoErrors(report)
  })

  it('和弦听辨：答错可重试（不 reveal 不变分），答对后由下一题收题', async () => {
    const doc = build(specOf('theory-choice.level.json'))
    const deck = buildDeck(doc).deck
    const first = deck[0]
    const answerIndex = rowOf(doc, first).answerIndex as number
    const wrongIndex = (answerIndex + 1) % 4
    const script: HarnessStep[] = [
      ...act('choice1', 'chosen', { index: wrongIndex, value: '不对的选项' }),
      ...act('choice1', 'chosen', { index: answerIndex, value: rowOf(doc, first).answer }),
      ...act('nextBtn', 'clicked'),
      ...answerScript(doc, deck.slice(1)),
    ]
    const report = await play(doc, { script })
    expect(report.ok, report.error).toBe(true)
    expect(report.score).toBe(20)
    expectNoErrors(report)
  })

  it('限时反应：答错后 timer.tick 超时返回（status: timeout，0 分），其余题计分', async () => {
    const doc = build(specOf('timed-reaction.level.json'))
    const deck = buildDeck(doc).deck
    const script: HarnessStep[] = [
      ...act('choice1', 'chosen', { index: 3, value: '不对的选项' }),
      ...act('timer1', 'tick', { count: 1 }),
      ...answerScript(doc, deck.slice(1)),
    ]
    const report = await play(doc, { script })
    expect(report.ok, report.error).toBe(true)
    expect(report.score).toBe(20)
    expect(report.passed).toBe(true)
    expect(report.questions[0]?.result).toMatchObject({ status: 'timeout', correct: false, scoreDelta: 0 })
    expectNoErrors(report)
  })

  it('音名拼写：错两次触发提示，再答对计分', async () => {
    const doc = build(specOf('note-spelling.level.json'))
    const deck = buildDeck(doc).deck
    const first = deck[0]
    const answer = rowOf(doc, first).answer
    const script: HarnessStep[] = [
      ...act('input1', 'submitted', { value: 'XYZ' }),
      ...act('input1', 'submitted', { value: 'ABC' }),
      ...act('input1', 'submitted', { value: answer }),
      ...answerScript(doc, deck.slice(1)),
    ]
    const report = await play(doc, { script })
    expect(report.ok, report.error).toBe(true)
    expect(report.score).toBe(30)
    expect(report.questions[0]?.result).toMatchObject({ correct: true, scoreDelta: 10 })
    expectNoErrors(report)
  })

  it('旋律听写：弹错整段后清空，再弹对计分', async () => {
    const doc = build(specOf('melody-dictation.level.json'))
    const deck = buildDeck(doc).deck
    const first = deck[0]
    const target = rowOf(doc, first).targetNotes as Json[]
    const wrong = target.map(() => 60)
    const script: HarnessStep[] = [
      ...wrong.map((midi) => surfaceStep('keys1', 'keyClicked', { midi, name: '' })),
      settleStep(),
      ...target.map((midi) => surfaceStep('keys1', 'keyClicked', { midi, name: '' })),
      settleStep(),
      ...answerScript(doc, deck.slice(1)),
    ]
    const report = await play(doc, { script })
    expect(report.ok, report.error).toBe(true)
    expect(report.score).toBe(30)
    expectNoErrors(report)
  })

  it('节奏跟拍：第一轮乱打未达标 → 清空重开 → 第二轮跟上计分', async () => {
    const doc = build(specOf('rhythm-follow.level.json'))
    const deck = buildDeck(doc).deck
    const first = deck[0]
    const grid = rowOf(doc, first).grid as Json[]
    const script: HarnessStep[] = [
      ...grid.map(() => surfaceStep('rhythm1', 'tap', { t: 0 })),
      settleStep(),
      surfaceStep('rhythm1', 'roundDone', { duration: 8 }),
      settleStep(),
      ...grid.map((t) => surfaceStep('rhythm1', 'tap', { t })),
      settleStep(),
      surfaceStep('rhythm1', 'roundDone', { duration: 8 }),
      settleStep(),
      ...answerScript(doc, deck.slice(1)),
    ]
    const report = await play(doc, { script })
    expect(report.ok, report.error).toBe(true)
    expect(report.score).toBe(20)
    expect(report.passed).toBe(true)
    expectNoErrors(report)
  })

  it('调音入门：先偏音（连续不达标）再达标计分', async () => {
    const doc = build(specOf('tune-intro.level.json'))
    const deck = buildDeck(doc).deck
    const first = deck[0]
    const targetMidi = rowOf(doc, first).targetMidi as number
    const offFreq = 440 * Math.pow(2, (targetMidi + 1 - 69) / 12)
    const script: HarnessStep[] = [
      // 偏音只重置连续命中计数；随后连续命中即可达标
      ...act('tuner1', 'pitch', { freq: offFreq, midi: targetMidi + 1, cents: 0, clarity: 1 }),
      ...answerScript(doc, [first]),
      ...answerScript(doc, deck.slice(1)),
    ]
    const report = await play(doc, { script })
    expect(report.ok, report.error).toBe(true)
    expect(report.score).toBe(20)
    expectNoErrors(report)
  })
})

// ---------------------------------------------------------------------------
// 数据变更属性测试：改数据不改流程图
// ---------------------------------------------------------------------------

/** 内容行深拷贝（属性变更用；只动数据，不动 flow） */
function cloneRow(id: string, source: Record<string, Json>): QuestionRow {
  const copy = JSON.parse(JSON.stringify(source)) as Record<string, Json>
  return { ...copy, id } as QuestionRow
}

function appendRow(doc: LevelDocV4, typeId: string, extra: { draft?: boolean } = {}): void {
  const table = doc.content.tables[typeId]
  const base = table.rows[0]
  const content = { ...base }
  delete content.draft
  delete content.phase
  delete content.order
  const added = cloneRow(uniqueRowId(table.rows.map((row) => row.id)), content as Record<string, Json>)
  if (extra.draft) added.draft = true
  table.rows.push(added)
}

function uniqueRowId(used: string[]): string {
  let index = 1
  let id = 'row_extra'
  while (used.includes(id)) id = `row_extra_${index++}`
  return id
}

/** 属性变更清单：每项 = 名称 + 在副本上改数据 + 是否支持该样例 */
interface Mutation {
  name: string
  supports: (spec: SampleLevelSpec) => boolean
  apply: (doc: LevelDocV4, spec: SampleLevelSpec) => void
}

const primaryType = (spec: SampleLevelSpec): string => spec.typeIds[spec.typeIds.length - 1]

const MUTATIONS: Mutation[] = [
  {
    name: '加行（自动题单 +1）',
    supports: () => true,
    apply: (doc, spec) => appendRow(doc, primaryType(spec)),
  },
  {
    name: '加草稿行（自动题单不变）',
    supports: () => true,
    apply: (doc, spec) => appendRow(doc, primaryType(spec), { draft: true }),
  },
  {
    name: '草稿翻转为正式（自动题单 +1）',
    supports: () => true,
    apply: (doc, spec) => {
      appendRow(doc, primaryType(spec))
      const table = doc.content.tables[primaryType(spec)]
      const last = table.rows[table.rows.length - 1]
      last.draft = true
      expect(buildAutoManifest(doc).some((slot) => slot.row === last.id)).toBe(false)
      delete last.draft
    },
  },
  {
    name: '删行（自动题单 -1）',
    supports: (spec) => spec.flowKind === 'sequence',
    apply: (doc, spec) => {
      const table = doc.content.tables[primaryType(spec)]
      expect(table.rows.length).toBeGreaterThan(1)
      table.rows.pop()
    },
  },
  {
    name: '重排行（顺序反转）',
    supports: () => true,
    apply: (doc, spec) => {
      doc.content.tables[primaryType(spec)].rows.reverse()
    },
  },
  {
    name: '改 phase（分组顺序变化）',
    supports: (spec) => spec.flowKind === 'sequence',
    apply: (doc, spec) => {
      const table = doc.content.tables[primaryType(spec)]
      table.rows[table.rows.length - 1].phase = 2
    },
  },
  {
    name: '改 order（阶段内顺序变化）',
    supports: (spec) => spec.flowKind === 'sequence',
    apply: (doc, spec) => {
      const table = doc.content.tables[primaryType(spec)]
      table.rows.forEach((row, index) => {
        row.order = table.rows.length - 1 - index
      })
    },
  },
  {
    name: '显式题单新增（倒序执行）',
    supports: () => true,
    apply: (doc) => {
      const auto = buildAutoManifest(doc)
      doc.content.manifest = { entries: [...auto].reverse().map((slot) => ({ type: slot.type, row: slot.row })) }
    },
  },
  {
    name: '显式题单删除（回退自动题单）',
    supports: () => true,
    apply: (doc) => {
      const auto = buildAutoManifest(doc)
      doc.content.manifest = { entries: auto.map((slot) => ({ type: slot.type, row: slot.row })) }
      delete doc.content.manifest
    },
  },
  {
    name: '显式题单 args 变更（choice-listen bonus 加分）',
    supports: (spec) => spec.typeIds.includes('choice-listen'),
    apply: (doc) => {
      const auto = buildAutoManifest(doc)
      doc.content.manifest = { entries: auto.map((slot) => ({ type: slot.type, row: slot.row, args: { bonus: 5 } })) }
    },
  },
  {
    name: 'shuffle + seed 复现（牌堆确定且可重放）',
    supports: (spec) => spec.flowKind === 'sequence',
    apply: (doc) => {
      doc.content.run.order = 'shuffle'
      doc.content.run.seed = 20261027
      doc.content.run.shuffleWithinPhase = true
    },
  },
]

describe('v4 内置样例 · 数据变更属性测试（改数据不改图）', () => {
  it('属性变更类别覆盖 ≥8 类（任务板 W4.4 DoD）', () => {
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(8)
    for (const keyword of ['加行', '删行', '重排', '草稿', 'phase', 'order', '显式题单', 'args']) {
      expect(MUTATIONS.some((mutation) => mutation.name.includes(keyword)), `缺少变更类别：${keyword}`).toBe(true)
    }
  })

  for (const spec of SAMPLE_LEVELS) {
    for (const mutation of MUTATIONS) {
      if (!mutation.supports(spec)) continue
      it(`${spec.title} · ${mutation.name}`, async () => {
        const specDoc = build(spec)
        const flowSnapshot = JSON.stringify(specDoc.content.flow)
        const mutated = cloneLevelDocV4(specDoc)
        mutation.apply(mutated, spec)
        // 流程图零修改（属性语义：所有变更只动数据/题单/发牌配置）
        expect(JSON.stringify(mutated.content.flow)).toBe(flowSnapshot)
        const doc = loaded(mutated)
        const deck = buildDeck(doc).deck
        const isTutorial = spec.flowKind === 'tutorial'
        const expectedQuestions = isTutorial ? TUTORIAL_ASKS.length : deck.length
        const expected = isTutorial ? 10 : expectedScore(doc, deck)
        const report = await play(doc, {
          script: isTutorial ? tutorialScript(doc) : answerScript(doc, deck),
          timeoutMs: isTutorial ? 80 : 2000,
        })
        if (isTutorial) {
          expect(report.score).toBe(expected)
          expect(report.passed).toBe(true)
        } else {
          expect(report.ok, report.error).toBe(true)
          expect(report.finished).toBe(true)
          expect(report.score).toBe(expected)
          expect(report.passed).toBe(expected >= spec.passScore)
          expect(report.questions.map((entry) => entry.rowId)).toEqual(deck.map((item) => item.row))
        }
        expect(report.questions).toHaveLength(expectedQuestions)
        expect(report.deck).toEqual(deck)
        expectNoErrors(report)
        // 显式题单/args 变更后，题单构造仍与 buildDeck 一致（自动/显式优先逻辑）
        if (doc.content.manifest) {
          expect(deck).toHaveLength(doc.content.manifest.entries.length)
        }
      })
    }
  }

  it('shuffle + seed：同一 seed 两次跑出同一牌堆', async () => {
    const spec = specOf('theory-choice.level.json')
    const mutated = cloneLevelDocV4(build(spec))
    mutated.content.run.order = 'shuffle'
    mutated.content.run.seed = 7
    const doc = loaded(mutated)
    const deck = buildDeck(doc).deck
    const first = await play(doc, { deck })
    const second = await play(doc, { deck })
    expect(first.deck).toEqual(second.deck)
    expect(first.deck).toEqual(deck)
    expect(first.seed).toBe(second.seed)
    expect(first.ok, first.error).toBe(true)
    expect(second.ok, second.error).toBe(true)
  })
})
