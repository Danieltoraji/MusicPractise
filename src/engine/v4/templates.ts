/**
 * v4 零代码关卡模板（docs/51 §3.6 / §5.2；docs/53 §14「零代码模板」）。
 *
 * 设计：
 * - **同一语义的生成层，不是隐藏运行时**：每个模板返回完整 `LevelDocV4`（shell 视图/组件、
 *   内置题型、实例表、run 配置、flow main），流程节点组复用 `presets` 的印章预设
 *   （`sequence-grade-settle` / `settle-then-replay`），生成后就是普通 IR，作者可展开成节点图修改。
 * - 题型直接复用 `src/sample/v4/types` 的内置题型 builder（docs/51 §3.6「题型库」），
 *   模板只负责「文档装配 + 示例数据 + shell + 流程」；`blank` 自带一个最小选择题型作起点。
 * - 全部模板必须通过 `loadLevelDocV4` 且 `lintWarnings = []`；测试另用 `runLevelHeadless` 无头验证。
 */
import type { Json } from '../expr'
import type {
  BehaviorNode,
  BehaviorProgram,
  ColumnDefV4,
  ComponentInstanceV4,
  FlowNode,
  GraphEdge,
  LevelDocV4,
  LevelShell,
  QuestionRow,
  QuestionTable,
  QuestionTypeDef,
  RunConfig,
  ViewDefV4,
} from './model'
import { LOGIC_VERSION_V4, SCHEMA_VERSION_V4 } from './model'
import { newResourceId } from '../../library/id'
import {
  buildButtonStepType,
  buildChoiceListenType,
  buildRhythmTapType,
  buildSliderStepType,
} from '../../sample/v4/types'
import {
  buildPreset,
  connectProgramNodes,
  insertPresetIntoDoc,
  mergePresetResult,
} from './presets'

// ---------------------------------------------------------------------------
// 文档装配助手（只构造纯 JSON，不依赖 runtime/editor）
// ---------------------------------------------------------------------------

export const TEMPLATE_STAGE = { width: 800, height: 470 } as const

const DEFAULT_RUN: RunConfig = { order: 'manifest', count: null, seed: null, shuffleWithinPhase: true }

function view(id: string, name?: string): ViewDefV4 {
  return name === undefined ? { id } : { id, name }
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function box(x: number, y: number, w: number, h: number): Box {
  return { x, y, w, h }
}

function shellComponent(
  id: string,
  type: string,
  viewId: string,
  layout: Box,
  options: { name?: string; props?: Record<string, Json>; bindings?: Record<string, string>; visible?: boolean } = {},
): ComponentInstanceV4 {
  const component: ComponentInstanceV4 = { id, type, view: viewId, layout }
  if (options.name !== undefined) component.name = options.name
  if (options.visible !== undefined) component.visible = options.visible
  if (options.props !== undefined) component.props = options.props
  if (options.bindings !== undefined) component.bindings = options.bindings
  return component
}

function column(key: string, type: ColumnDefV4['type'], label?: string): ColumnDefV4 {
  const out: ColumnDefV4 = { key, type }
  if (label !== undefined) out.label = label
  return out
}

function row(id: string, content: Record<string, Json>, options: { draft?: boolean; phase?: number; order?: number } = {}): QuestionRow {
  const out: QuestionRow = { id }
  if (options.draft !== undefined) out.draft = options.draft
  if (options.phase !== undefined) out.phase = options.phase
  if (options.order !== undefined) out.order = options.order
  for (const [key, value] of Object.entries(content)) out[key] = value
  return out
}

function table(columns: ColumnDefV4[], rows: QuestionRow[]): QuestionTable {
  return { columns, rows }
}

/** 通用计分 shell：main 视图（标题/得分/进度）+ settled 视图（结算文本） */
function scoreShell(title: string): LevelShell {
  return {
    views: [view('main', '主视图'), view('settled', '结算视图')],
    components: [
      shellComponent('titleLabel', 'label', 'main', box(24, 12, 552, 28), { name: '关卡标题', props: { text: title } }),
      shellComponent('scoreLabel', 'label', 'main', box(600, 12, 176, 28), {
        name: '得分',
        bindings: { text: "'得分 ' + v.score" },
      }),
      shellComponent('progressLabel', 'label', 'main', box(24, 44, 552, 24), {
        name: '进度',
        bindings: { text: "'进度 ' + v.row + ' / ' + run.total" },
      }),
      shellComponent('settledLabel', 'label', 'settled', box(200, 110, 400, 48), {
        name: '结算文本',
        bindings: { text: "'本关得分 ' + v.score" },
      }),
    ],
  }
}

interface TemplateDocSpec {
  title: string
  description: string
  tags: string[]
  difficulty: 1 | 2 | 3 | 4 | 5
  shell: LevelShell
  types: QuestionTypeDef[]
  tables: Record<string, QuestionTable>
}

/** 模板文档骨架：flow 只有 start（流程节点组由预设展开后追加/接线） */
function baseTemplateDoc(spec: TemplateDocSpec): LevelDocV4 {
  return {
    schemaVersion: SCHEMA_VERSION_V4,
    kind: 'level',
    id: newResourceId(),
    version: '0.1.0',
    meta: {
      title: spec.title,
      description: spec.description,
      author: { name: '' },
      tags: spec.tags,
      locale: 'zh-CN',
      license: 'CC0-1.0',
      difficulty: spec.difficulty,
    },
    content: {
      shell: spec.shell,
      types: spec.types,
      tables: spec.tables,
      run: { ...DEFAULT_RUN },
      flow: {
        logicVersion: LOGIC_VERSION_V4,
        kind: 'flow',
        nodes: [{ id: 'f_start', kind: 'start' }],
        edges: [],
      },
    },
  }
}

/**
 * 用 `sequence-grade-settle` 预设生成主流程并接到 start：
 * start → foreach(run.questions) → ask → v.score += scoreDelta → v.row → finish。
 * flow.vars（v.score/v.row）由 insertPresetIntoDoc 自动补齐。
 */
function withSequenceFlow(doc: LevelDocV4, passExpr: string): LevelDocV4 {
  const inserted = insertPresetIntoDoc(doc, 'sequence-grade-settle', { params: { passExpr } })
  const entryId = inserted.result.entryId
  if (entryId === undefined) throw new Error('sequence-grade-settle 预设缺少入口节点，模板无法接线')
  const flow = connectProgramNodes(inserted.doc.content.flow, 'f_start', entryId)
  return { ...inserted.doc, content: { ...inserted.doc.content, flow } }
}

function withOverrides(
  doc: LevelDocV4,
  options: { id?: string; title?: string; description?: string; version?: string },
): LevelDocV4 {
  const meta = { ...doc.meta }
  if (options.title !== undefined) meta.title = options.title
  if (options.description !== undefined) meta.description = options.description
  return {
    ...doc,
    id: options.id ?? doc.id,
    version: options.version ?? doc.version,
    meta,
  }
}

// ---------------------------------------------------------------------------
// blank：最小可用起点（1 个题型 + 示例数据 + 预设流程）
// ---------------------------------------------------------------------------

/** 空白模板的最小选择题型（prompt + choice；答对计 q.scoring，自动返回） */
function buildBlankChoiceType(): QuestionTypeDef {
  const behavior: BehaviorProgram = {
    logicVersion: LOGIC_VERSION_V4,
    kind: 'behavior',
    nodes: [
      { id: 'b_onStart', kind: 'on', event: 'start' },
      { id: 'b_startGuard', kind: 'branch', cond: 'q.state.answered' },
      { id: 'b_startDup', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: 0 }" },
      { id: 'b_onChosen', kind: 'on', event: 'choice1.chosen' },
      { id: 'b_isCorrect', kind: 'branch', cond: 'event.payload.index == q.answerIndex' },
      { id: 'b_markAnswered', kind: 'assign', target: 'q.state.answered', value: { expr: 'true' } },
      { id: 'b_reveal', kind: 'call', target: 'choice1', method: 'reveal', arg: '{ correctIndex: q.answerIndex }' },
      { id: 'b_retOk', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: q.scoring }" },
      { id: 'b_comment', kind: 'comment', text: '空白模板内置题型：答对即计分返回；可在「题型 → 行为」里改判定/计分/返回时机' },
    ],
    edges: [
      { id: 'be_1', from: 'b_onStart', to: 'b_startGuard' },
      { id: 'be_2', from: 'b_startGuard', to: 'b_startDup', port: 'true' },
      { id: 'be_3', from: 'b_onChosen', to: 'b_isCorrect' },
      { id: 'be_4', from: 'b_isCorrect', to: 'b_markAnswered', port: 'true' },
      { id: 'be_5', from: 'b_markAnswered', to: 'b_reveal' },
      { id: 'be_6', from: 'b_reveal', to: 'b_retOk' },
    ],
  }
  return {
    id: 'choice',
    name: '选择题',
    description: '最简选择题：题面 + 选项，答对计 q.scoring 并返回。',
    surface: {
      components: [
        {
          id: 'prompt',
          type: 'label',
          name: '题面',
          layout: box(24, 16, 752, 32),
          bindings: { text: 'q.prompt' },
        },
        {
          id: 'choice1',
          type: 'choice',
          name: '选项',
          layout: box(24, 80, 752, 260),
          bindings: { options: 'q.options' },
        },
      ],
    },
    behavior,
    state: [{ key: 'answered', type: 'boolean', init: false }],
  }
}

function buildBlankTemplate(options: { id?: string; title?: string } = {}): LevelDocV4 {
  const doc = baseTemplateDoc({
    title: '空白关卡',
    description: '从一张最简单的选择题开始：1 个题型 + 示例数据 + 顺序出题/计分/结算流程，改数据即可用。',
    tags: ['空白', '起点'],
    difficulty: 1,
    shell: scoreShell('空白关卡'),
    types: [buildBlankChoiceType()],
    tables: {
      choice: table(
        [column('prompt', 'text', '题面'), column('options', 'list', '选项'), column('answerIndex', 'number', '答案下标'), column('scoring', 'number', '分值')],
        [
          row('row_01', {
            prompt: '点选正确答案（示例题，可在「内容」页编辑）',
            options: ['选项 A', '选项 B'],
            answerIndex: 0,
            scoring: 10,
          }),
        ],
      ),
    },
  })
  return withOverrides(withSequenceFlow(doc, 'v.score >= 10'), options)
}

// ---------------------------------------------------------------------------
// listen-choice：听音选择
// ---------------------------------------------------------------------------

function buildListenChoiceTemplate(options: { id?: string; title?: string } = {}): LevelDocV4 {
  const title = '听音选择'
  const doc = baseTemplateDoc({
    title,
    description: '听音频选答案：choice + sound + 重听/下一题按钮，预置 2 道听音题；流程复用「顺序出题 · 计分结算」预设。',
    tags: ['练耳', '选择题'],
    difficulty: 2,
    shell: scoreShell(title),
    types: [buildChoiceListenType()],
    tables: {
      'choice-listen': table(
        [
          column('prompt', 'text', '题面'),
          column('options', 'list', '选项'),
          column('answer', 'text', '答案'),
          column('answerIndex', 'number', '答案下标'),
          column('listenNotes', 'notes', '听音'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_01', {
            prompt: '听三个音，最后一个音是？',
            options: ['Do', 'Re', 'Mi'],
            answer: 'Mi',
            answerIndex: 2,
            listenNotes: [{ midi: 60, dur: '8n' }, { midi: 62, dur: '8n' }, { midi: 64, dur: '2n' }],
            scoring: 10,
          }),
          row('row_02', {
            prompt: '再听一个，第一个音是？',
            options: ['Do', 'Re', 'Sol'],
            answer: 'Sol',
            answerIndex: 2,
            listenNotes: [{ midi: 67, dur: '2n' }, { midi: 64, dur: '8n' }, { midi: 62, dur: '8n' }],
            scoring: 10,
          }),
        ],
      ),
    },
  })
  return withOverrides(withSequenceFlow(doc, 'v.score >= 20'), options)
}

// ---------------------------------------------------------------------------
// rhythm-tap：节奏跟拍
// ---------------------------------------------------------------------------

/** 8 拍、每拍两下的栅格（秒；与 rhythm 组件 tap.t 同一基准） */
function eighthGrid(bpm: number): Json[] {
  const secondsPerBeat = 60 / bpm
  const out: Json[] = []
  for (let beat = 0; beat < 8; beat += 0.5) out.push(Math.round(beat * secondsPerBeat * 1000) / 1000)
  return out
}

function buildRhythmTapTemplate(options: { id?: string; title?: string } = {}): LevelDocV4 {
  const title = '节奏跟拍'
  const doc = baseTemplateDoc({
    title,
    description: '跟着节拍器在圆盘打拍：rhythm 组件 + rhythmScore 判定 + 未达标重开一轮；预置 2 条节奏。',
    tags: ['节奏', '跟拍'],
    difficulty: 2,
    shell: scoreShell(title),
    types: [buildRhythmTapType()],
    tables: {
      'rhythm-tap': table(
        [
          column('prompt', 'text', '题面'),
          column('grid', 'json', '节奏栅格（秒）'),
          column('bpm', 'number', '速度'),
          column('beats', 'number', '拍数'),
          column('tolerance', 'number', '容差（秒）'),
          column('passRatio', 'number', '达标比例'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_80bpm', {
            prompt: '80 BPM · 8 拍，跟着打',
            grid: eighthGrid(80),
            bpm: 80,
            beats: 8,
            tolerance: 0.12,
            passRatio: 0.8,
            scoring: 10,
          }),
          row('row_104bpm', {
            prompt: '提高到 104 BPM',
            grid: eighthGrid(104),
            bpm: 104,
            beats: 8,
            tolerance: 0.12,
            passRatio: 0.8,
            scoring: 10,
          }),
        ],
      ),
    },
  })
  return withOverrides(withSequenceFlow(doc, 'v.score >= 20'), options)
}

// ---------------------------------------------------------------------------
// tutorial：新手教程（固定 3 步 + 结算后 waitShell → restart）
// ---------------------------------------------------------------------------

function buildTutorialTemplate(options: { id?: string; title?: string } = {}): LevelDocV4 {
  const title = '新手教程'
  const shell: LevelShell = {
    views: [view('welcome', '欢迎'), view('main', '教程进行中'), view('done', '完成')],
    components: [
      shellComponent('welcomeTitle', 'label', 'welcome', box(24, 40, 752, 44), {
        name: '欢迎标题',
        props: { text: '🎵 欢迎来到音乐练习！' },
      }),
      shellComponent('welcomeDesc', 'label', 'welcome', box(24, 100, 752, 96), {
        name: '欢迎说明',
        props: { text: '三步认识本平台的交互：按钮 → 滑块 → 听音选择。\n随时可以点页面底部的「重开本关」从头来过。' },
      }),
      shellComponent('startBtn', 'button', 'welcome', box(300, 230, 200, 56), {
        name: '开始按钮',
        props: { text: '开始 ▶' },
      }),
      shellComponent('mainTitle', 'label', 'main', box(24, 12, 552, 28), {
        name: '教程标题',
        props: { text: title },
      }),
      shellComponent('mainScore', 'label', 'main', box(600, 12, 176, 28), {
        name: '得分',
        bindings: { text: "'得分 ' + v.score" },
      }),
      shellComponent('doneTitle', 'label', 'done', box(24, 60, 752, 44), {
        name: '完成标题',
        props: { text: '🎉 教程完成！' },
      }),
      shellComponent('doneScore', 'label', 'done', box(24, 120, 752, 36), {
        name: '本关得分',
        bindings: { text: "'本关得分 ' + v.score" },
      }),
      shellComponent('replayBtn', 'button', 'done', box(300, 220, 200, 56), {
        name: '再学一遍',
        props: { text: '再学一遍' },
      }),
    ],
  }
  const doc = baseTemplateDoc({
    title,
    description: '欢迎页 → 3 步交互（按钮/滑块/听音选择）→ 结算 →「再学一遍」重开；固定步骤流程，演示结算后 waitShell → restart 预设。',
    tags: ['教程', '新手'],
    difficulty: 1,
    shell,
    types: [buildButtonStepType(), buildSliderStepType(), buildChoiceListenType()],
    tables: {
      'button-step': table(
        [column('prompt', 'text', '题面'), column('scoring', 'number', '分值')],
        [row('row_button', { prompt: '点一下按钮，看看会发生什么。', scoring: 0 })],
      ),
      'slider-step': table(
        [column('prompt', 'text', '题面'), column('target', 'number', '参考值'), column('scoring', 'number', '分值')],
        [row('row_slider', { prompt: '拖动滑块，把数值拖到任意位置，然后点下一步。', target: 42, scoring: 0 })],
      ),
      'choice-listen': table(
        [
          column('prompt', 'text', '题面'),
          column('options', 'list', '选项'),
          column('answer', 'text', '答案'),
          column('answerIndex', 'number', '答案下标'),
          column('listenNotes', 'notes', '听音'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_choice', {
            prompt: '听三音：Do-Re-Mi，最后一个音是？',
            options: ['Do', 'Re', 'Mi'],
            answer: 'Mi',
            answerIndex: 2,
            listenNotes: [{ midi: 60, dur: '8n' }, { midi: 62, dur: '8n' }, { midi: 64, dur: '2n' }],
            scoring: 10,
          }),
        ],
      ),
    },
  })

  // 固定 3 步流程（docs/51 §6 教程）：与样例 tutorial-hello 同构，但用模板 id/标题
  const nodes: FlowNode[] = [
    { id: 'f_start', kind: 'start' },
    { id: 'f_welcome', kind: 'setView', view: 'welcome' },
    { id: 'f_waitStart', kind: 'waitShell', event: 'startBtn.clicked' },
    { id: 'f_main', kind: 'setView', view: 'main' },
    { id: 'f_askButton', kind: 'ask', target: "{ type: 'button-step', row: 'row_button' }", resultVar: 'r1' },
    { id: 'f_add1', kind: 'assign', target: 'v.score', value: { expr: 'v.score + (local.r1.scoreDelta || 0)' } },
    { id: 'f_askSlider', kind: 'ask', target: "{ type: 'slider-step', row: 'row_slider' }", resultVar: 'r2' },
    { id: 'f_add2', kind: 'assign', target: 'v.score', value: { expr: 'v.score + (local.r2.scoreDelta || 0)' } },
    { id: 'f_askChoice', kind: 'ask', target: "{ type: 'choice-listen', row: 'row_choice' }", resultVar: 'r3' },
    { id: 'f_add3', kind: 'assign', target: 'v.score', value: { expr: 'v.score + (local.r3.scoreDelta || 0)' } },
    { id: 'f_done', kind: 'setView', view: 'done' },
  ]
  const chain = (prefix: string, ids: string[]): { id: string; from: string; to: string }[] =>
    ids.slice(0, -1).map((from, index) => ({ id: `${prefix}_${index + 1}`, from, to: ids[index + 1] }))
  const base: LevelDocV4 = {
    ...doc,
    content: {
      ...doc.content,
      flow: {
        logicVersion: LOGIC_VERSION_V4,
        kind: 'flow',
        nodes,
        edges: chain(
          'fe',
          nodes.map((node) => node.id),
        ),
      },
    },
  }
  // 结算后展示/重玩：finish → waitShell(replayBtn.clicked) → restart（复用 settle-then-replay 预设）
  const settlePreset = buildPreset('settle-then-replay', { doc: base }, {
    passExpr: 'v.score >= 10',
    replayEvent: 'replayBtn.clicked',
  })
  const entryId = settlePreset.entryId
  if (entryId === undefined) throw new Error('settle-then-replay 预设缺少入口节点，教程模板无法接线')
  let flow = mergePresetResult(base.content.flow, settlePreset)
  flow = connectProgramNodes(flow, 'f_done', entryId)
  flow = { ...flow, vars: [{ key: 'score', type: 'number', init: 0 }] }
  const assembled: LevelDocV4 = { ...base, content: { ...base.content, flow } }
  return withOverrides(assembled, options)
}

// ---------------------------------------------------------------------------
// step-clock：分步作答 + 全局计时（v4.1：题内视图 + run.elapsedMs 实时显示）
// ---------------------------------------------------------------------------

/** 题内分步：intro 视图（题面 + 开始）→ answer 视图（选项 + 反馈 + 下一题） */
function buildStepClockType(): QuestionTypeDef {
  const nodes: BehaviorNode[] = [
    { id: 'b_onStart', kind: 'on', event: 'start' },
    { id: 'b_startView', kind: 'setView', view: 'intro' },
    { id: 'b_startGuard', kind: 'branch', cond: 'q.state.answered' },
    { id: 'b_startRet', kind: 'return', result: "{ status: 'answered', scoreDelta: 0 }" },
    { id: 'b_onGo', kind: 'on', event: 'startBtn.clicked' },
    { id: 'b_goView', kind: 'setView', view: 'answer' },
    { id: 'b_setOptions', kind: 'call', target: 'choice1', method: 'setOptions', arg: '{ options: q.options }' },
    { id: 'b_goGuard', kind: 'branch', cond: 'q.state.answered' },
    { id: 'b_goRet', kind: 'return', result: "{ status: 'answered', scoreDelta: 0 }" },
    { id: 'b_onChosen', kind: 'on', event: 'choice1.chosen' },
    { id: 'b_chosenGuard', kind: 'branch', cond: 'q.state.answered' },
    { id: 'b_chosenRet', kind: 'return', result: "{ status: 'answered', scoreDelta: 0 }" },
    { id: 'b_isCorrect', kind: 'branch', cond: 'event.payload.index == q.answerIndex' },
    { id: 'b_markAnswered', kind: 'assign', target: 'q.state.answered', value: { expr: 'true' } },
    { id: 'b_reveal', kind: 'call', target: 'choice1', method: 'reveal', arg: '{ correctIndex: q.answerIndex }' },
    { id: 'b_feedbackOk', kind: 'call', target: 'feedback', method: 'show', arg: "{ text: '答对了！点「下一题」继续。', tone: 'success' }" },
    { id: 'b_feedbackBad', kind: 'call', target: 'feedback', method: 'show', arg: "{ text: '不是这个，再看看。', tone: 'error' }" },
    { id: 'b_onNext', kind: 'on', event: 'nextBtn.clicked' },
    { id: 'b_nextGuard', kind: 'branch', cond: 'q.state.answered' },
    { id: 'b_nextScored', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: q.scoring }" },
    { id: 'b_nextSkipped', kind: 'return', result: "{ status: 'skipped', correct: false, scoreDelta: 0 }" },
    { id: 'b_comment', kind: 'comment', text: '分步作答：intro 视图读题 → answer 视图作答；题内视图只过滤渲染，q.state 跨视图保留' },
  ]
  const edges: GraphEdge[] = [
    { id: 'be_1', from: 'b_onStart', to: 'b_startView' },
    { id: 'be_2', from: 'b_startView', to: 'b_startGuard' },
    { id: 'be_3', from: 'b_startGuard', to: 'b_startRet', port: 'true' },
    { id: 'be_4', from: 'b_onGo', to: 'b_goView' },
    { id: 'be_5', from: 'b_goView', to: 'b_setOptions' },
    { id: 'be_6', from: 'b_setOptions', to: 'b_goGuard' },
    { id: 'be_7', from: 'b_goGuard', to: 'b_goRet', port: 'true' },
    { id: 'be_8', from: 'b_onChosen', to: 'b_chosenGuard' },
    { id: 'be_9', from: 'b_chosenGuard', to: 'b_chosenRet', port: 'true' },
    { id: 'be_10', from: 'b_chosenGuard', to: 'b_isCorrect', port: 'false' },
    { id: 'be_11', from: 'b_isCorrect', to: 'b_markAnswered', port: 'true' },
    { id: 'be_12', from: 'b_markAnswered', to: 'b_reveal' },
    { id: 'be_13', from: 'b_reveal', to: 'b_feedbackOk' },
    { id: 'be_14', from: 'b_isCorrect', to: 'b_feedbackBad', port: 'false' },
    { id: 'be_15', from: 'b_onNext', to: 'b_nextGuard' },
    { id: 'be_16', from: 'b_nextGuard', to: 'b_nextScored', port: 'true' },
    { id: 'be_17', from: 'b_nextGuard', to: 'b_nextSkipped', port: 'false' },
  ]
  return {
    id: 'step-choice',
    name: '分步选择题',
    description: '题内两视图（读题 / 作答）+ 跨视图保留作答状态；点「开始作答」切到选项。',
    surface: {
      views: [view('intro', '读题'), view('answer', '作答')],
      initialView: 'intro',
      components: [
        {
          id: 'prompt',
          type: 'label',
          name: '题面',
          layout: box(24, 16, 752, 40),
          bindings: { text: 'q.prompt' },
        },
        {
          id: 'startBtn',
          type: 'button',
          name: '开始作答',
          view: 'intro',
          layout: box(300, 200, 200, 56),
          props: { text: '开始作答 →' },
        },
        {
          id: 'choice1',
          type: 'choice',
          name: '选项',
          view: 'answer',
          layout: box(24, 80, 752, 240),
        },
        {
          id: 'feedback',
          type: 'label',
          name: '反馈',
          view: 'answer',
          layout: box(24, 336, 752, 40),
          props: { text: '' },
        },
        {
          id: 'nextBtn',
          type: 'button',
          name: '下一题',
          view: 'answer',
          layout: box(600, 388, 176, 44),
          props: { text: '下一题 →' },
        },
      ],
    },
    behavior: {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'behavior',
      nodes,
      edges,
    },
    state: [{ key: 'answered', type: 'boolean', init: false }],
  }
}

function buildStepClockTemplate(options: { id?: string; title?: string } = {}): LevelDocV4 {
  const title = '分步作答 · 全局计时'
  const shell: LevelShell = {
    views: [view('main', '主视图'), view('settled', '结算视图')],
    components: [
      shellComponent('titleLabel', 'label', 'main', box(24, 12, 420, 28), { name: '关卡标题', props: { text: title } }),
      shellComponent('clockLabel', 'label', 'main', box(460, 12, 180, 28), {
        name: '全局计时',
        bindings: { text: "'⏱ ' + floor(run.elapsedMs / 1000) + 's'" },
      }),
      shellComponent('scoreLabel', 'label', 'main', box(650, 12, 126, 28), {
        name: '得分',
        bindings: { text: "'得分 ' + v.score" },
      }),
      shellComponent('progressLabel', 'label', 'main', box(24, 44, 552, 24), {
        name: '进度',
        bindings: { text: "'进度 ' + v.row + ' / ' + run.total" },
      }),
      shellComponent('settledLabel', 'label', 'settled', box(200, 110, 400, 48), {
        name: '结算文本',
        bindings: { text: "'本关得分 ' + v.score + ' · 用时 ' + floor(run.elapsedMs / 1000) + 's'" },
      }),
    ],
  }
  const doc = baseTemplateDoc({
    title,
    description:
      '分步作答 + 全局计时：题内 intro/answer 两视图（behavior setView 切换）；shell 绑定 run.elapsedMs 实时显示本关用时（finish 定格）。',
    tags: ['分步', '计时', '模板'],
    difficulty: 2,
    shell,
    types: [buildStepClockType()],
    tables: {
      'step-choice': table(
        [
          column('prompt', 'text', '题面'),
          column('options', 'list', '选项'),
          column('answerIndex', 'number', '答案下标'),
          column('scoring', 'number', '分值'),
        ],
        [
          row('row_01', {
            prompt: '先读题，再点「开始作答」：这是第一个音吗？（示例题）',
            options: ['是', '否'],
            answerIndex: 0,
            scoring: 10,
          }),
          row('row_02', {
            prompt: '再来一题：分步视图切回读题了吗？',
            options: ['是', '否'],
            answerIndex: 0,
            scoring: 10,
          }),
        ],
      ),
    },
  })
  return withOverrides(withSequenceFlow(doc, 'v.score >= 10'), options)
}

// ---------------------------------------------------------------------------
// 模板注册表 / 创建入口
// ---------------------------------------------------------------------------

export type LevelTemplateId = 'blank' | 'listen-choice' | 'rhythm-tap' | 'tutorial' | 'step-clock'

export interface LevelTemplateCreateOptions {
  /** 覆盖新关卡 id（默认程序化生成 res_…；测试/导入场景用） */
  id?: string
  /** 覆盖标题 */
  title?: string
  description?: string
  version?: string
}

export interface LevelTemplateDef {
  id: LevelTemplateId
  name: string
  description: string
  tags: string[]
  difficulty: 1 | 2 | 3 | 4 | 5
  /** 生成一个新关卡文档（每次都新建 id，勿共享引用） */
  create(options?: LevelTemplateCreateOptions): LevelDocV4
}

/** 零代码模板目录（顺序即新建关卡向导展示顺序） */
export const LEVEL_TEMPLATES: LevelTemplateDef[] = [
  {
    id: 'blank',
    name: '空白关卡',
    description: '最简可用起点：1 个选择题型 + 1 行示例数据 + 顺序出题/计分/结算流程。',
    tags: ['空白', '起点'],
    difficulty: 1,
    create: (options = {}) => buildBlankTemplate(options),
  },
  {
    id: 'listen-choice',
    name: '听音选择',
    description: '听音频选答案：choice + sound + 重听/下一题按钮，预置 2 道听音题。',
    tags: ['练耳', '选择题'],
    difficulty: 2,
    create: (options = {}) => buildListenChoiceTemplate(options),
  },
  {
    id: 'rhythm-tap',
    name: '节奏跟拍',
    description: '跟着节拍器打拍：rhythm 组件 + rhythmScore 判定 + 未达标重开一轮，预置 2 条节奏。',
    tags: ['节奏', '跟拍'],
    difficulty: 2,
    create: (options = {}) => buildRhythmTapTemplate(options),
  },
  {
    id: 'tutorial',
    name: '新手教程',
    description: '欢迎页 → 3 步交互（按钮/滑块/听音选择）→ 结算 →「再学一遍」重开。',
    tags: ['教程', '新手'],
    difficulty: 1,
    create: (options = {}) => buildTutorialTemplate(options),
  },
  {
    id: 'step-clock',
    name: '分步作答 · 全局计时',
    description: '题内 intro/answer 两视图分步作答；shell 绑定 run.elapsedMs 实时显示本关用时（finish 定格）。',
    tags: ['分步', '计时', '模板'],
    difficulty: 2,
    create: (options = {}) => buildStepClockTemplate(options),
  },
]

/** 按 id 取模板定义（未知 id 返回 undefined） */
export function getLevelTemplate(id: string): LevelTemplateDef | undefined {
  return LEVEL_TEMPLATES.find((template) => template.id === id)
}

/**
 * 由模板创建一个完整 v4 关卡文档（新 id；可通过 options 覆盖 id/title）。
 * 未知模板 → 中文错误（列出可用模板 id）。
 */
export function createLevelFromTemplate(id: string, options: LevelTemplateCreateOptions = {}): LevelDocV4 {
  const template = getLevelTemplate(id)
  if (!template) {
    throw new Error(`未知关卡模板「${id}」；可用模板：${LEVEL_TEMPLATES.map((item) => item.id).join(' / ')}`)
  }
  return template.create(options)
}
