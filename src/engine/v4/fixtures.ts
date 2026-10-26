/**
 * v4 测试夹具：最小但完整的 LevelDocV4（可通过 schema / lint / 无头运行）。
 * 供 model/manifest/validate/lint/session 测试与 W2 会话用例复用；每次调用返回新对象，勿共享可变引用。
 */
import type { BehaviorProgram, LevelDocV4, LevelShell } from './model'
import { LOGIC_VERSION_V4, SCHEMA_VERSION_V4 } from './model'

export function emptyBehavior(): BehaviorProgram {
  return {
    logicVersion: LOGIC_VERSION_V4,
    kind: 'behavior',
    nodes: [
      { id: 'b_start', kind: 'on', event: 'start' },
      { id: 'b_return', kind: 'return', result: "{ status: 'answered', correct: true }" },
    ],
    edges: [{ id: 'be_1', from: 'b_start', to: 'b_return' }],
  }
}

export function minimalShell(): LevelShell {
  return {
    views: [{ id: 'main', name: '主视图' }],
    components: [
      {
        id: 'scoreLabel',
        type: 'label',
        name: '得分',
        view: 'main',
        layout: { x: 20, y: 20, w: 240, h: 32 },
        props: { text: '得分: 0' },
        bindings: { text: "'得分: ' + v.score" },
      },
    ],
  }
}

/** 最小 v4 关卡：1 题型 choice / 3 行（1 草稿）/ 自动题单 / start→assign→finish */
export function minimalLevelDoc(): LevelDocV4 {
  return {
    schemaVersion: SCHEMA_VERSION_V4,
    kind: 'level',
    id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A9',
    version: '1.0.0',
    meta: { title: 'v4 测试关卡', description: '引擎测试夹具' },
    content: {
      shell: minimalShell(),
      types: [
        {
          id: 'choice',
          name: '听音选择',
          description: '选择正确选项',
          surface: {
            components: [
              {
                id: 'prompt',
                type: 'label',
                name: '题面',
                layout: { x: 20, y: 70, w: 720, h: 36 },
                bindings: { text: 'q.prompt' },
              },
              {
                id: 'choice1',
                type: 'choice',
                name: '选项',
                layout: { x: 20, y: 130, w: 720, h: 200 },
                bindings: { options: 'q.options' },
              },
            ],
          },
          behavior: emptyBehavior(),
          state: [{ key: 'answered', type: 'boolean', init: false }],
          typeState: [{ key: 'asked', type: 'number', init: 0 }],
          args: [{ key: 'difficulty', type: 'number', optional: true, default: 1 }],
        },
      ],
      tables: {
        choice: {
          columns: [
            { key: 'prompt', label: '题面', type: 'text' },
            { key: 'options', label: '选项', type: 'list' },
            { key: 'scoring', label: '分值', type: 'number' },
          ],
          rows: [
            { id: 'row_01', prompt: '听一听，这是什么音？', options: ['Do', 'Re', 'Mi'], scoring: 10 },
            { id: 'row_02', prompt: '再听一个', options: ['Sol', 'La'], scoring: 10, phase: 2 },
            { id: 'row_03', prompt: '草稿题', options: ['A', 'B'], scoring: 10, draft: true },
          ],
        },
      },
      run: { order: 'manifest', count: null, seed: null, shuffleWithinPhase: true },
      flow: {
        logicVersion: LOGIC_VERSION_V4,
        kind: 'flow',
        nodes: [
          { id: 'f_start', kind: 'start' },
          { id: 'f_init', kind: 'assign', target: 'v.score', value: { expr: '0' } },
          { id: 'f_finish', kind: 'finish', passed: 'v.score >= 10' },
        ],
        edges: [
          { id: 'fe_1', from: 'f_start', to: 'f_init' },
          { id: 'fe_2', from: 'f_init', to: 'f_finish' },
        ],
        vars: [{ key: 'score', type: 'number', init: 0 }],
      },
    },
  }
}

/** 在最小关卡上追加第二种题型（含行排序/草稿用例），供题单/多题型测试使用 */
export function twoTypeLevelDoc(): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.content.types.push({
    id: 'listen',
    name: '听音',
    surface: { components: [] },
    behavior: emptyBehavior(),
  })
  doc.content.tables.listen = {
    columns: [{ key: 'prompt', label: '题面', type: 'text' }],
    rows: [
      { id: 'row_11', prompt: 'A', order: 2, phase: 1 },
      { id: 'row_12', prompt: 'B', order: 1, phase: 1 },
      { id: 'row_13', prompt: 'C', phase: 2 },
      { id: 'row_14', prompt: '草稿', draft: true },
    ],
  }
  return doc
}
