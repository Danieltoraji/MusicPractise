/**
 * 行为等价 golden：内置关卡 v1（LogicEngine）vs v3（migrateDocToV3 → GraphEngine）。
 * v3 迁移器把 questions→数据表、logicPatch.variables→行门控装载子图——
 * v1 侧在 questionLoaded 时同步应用补丁变量，两引擎在相同 q 作用域（迁移后的表格行）下双跑。
 * 另断言迁移确定性：v1 夹具的 v3 迁移逻辑 == 已入库的主 sample 逻辑。
 */
import { describe, expect, it } from 'vitest'
import type { LogicProgram } from './logic'
import { LogicEngine, type LogicHost } from './logic'
import { GraphEngine, type GraphHost } from './graphEngine'
import { migrateDocToV3 } from './migrateDoc'
import type { Json } from './expr'

import noteClickV1 from '../sample/fixtures/note-click.v1.json'
import theoryChoiceV1 from '../sample/fixtures/theory-choice.v1.json'
import melodyDictationV1 from '../sample/fixtures/melody-dictation.v1.json'
import timedReactionV1 from '../sample/fixtures/timed-reaction.v1.json'
import noteSpellingV1 from '../sample/fixtures/note-spelling.v1.json'
import clefTestV1 from '../sample/fixtures/clef-test.v1.json'
import rhythmFollowV1 from '../sample/fixtures/rhythm-follow.v1.json'
import tuneIntroV1 from '../sample/fixtures/tune-intro.v1.json'

import noteClickV3 from '../sample/note-click.level.json'
import theoryChoiceV3 from '../sample/theory-choice.level.json'
import melodyDictationV3 from '../sample/melody-dictation.level.json'
import timedReactionV3 from '../sample/timed-reaction.level.json'
import noteSpellingV3 from '../sample/note-spelling.level.json'
import clefTestV3 from '../sample/clef-test.level.json'
import rhythmFollowV3 from '../sample/rhythm-follow.level.json'
import tuneIntroV3 from '../sample/tune-intro.level.json'

type V1Doc = { content: { logic: unknown; questions: { id: string; data: Json; scoring?: Json; logicPatch?: { variables?: Record<string, Json> } }[] } }
type V3Doc = { content: { logic: unknown; table: { rows: Json[] } } }
const SAMPLES: [string, V1Doc, V3Doc][] = [
  ['note-click', noteClickV1, noteClickV3],
  ['theory-choice', theoryChoiceV1, theoryChoiceV3],
  ['melody-dictation', melodyDictationV1, melodyDictationV3],
  ['timed-reaction', timedReactionV1, timedReactionV3],
  ['note-spelling', noteSpellingV1, noteSpellingV3],
  ['clef-test', clefTestV1, clefTestV3],
  ['rhythm-follow', rhythmFollowV1, rhythmFollowV3],
  ['tune-intro', tuneIntroV1, tuneIntroV3],
]

function makeRecorder() {
  const commands: { path: string; args: Json }[] = []
  const errors: string[] = []
  return { commands, errors }
}

/** 表达式里会读 q.data.* / q.scoring.max：两引擎统一用迁移后的表格首行作为作用域 q */
function firstRow(v1Doc: V1Doc): Json {
  return migrateDocToV3(v1Doc).content.table.rows[0] ?? null
}

/** 收集 v1 程序的事件入口并生成派发脚本（空 payload；生命周期事件用真实负载；row=0 供行门控） */
function eventScript(logic: LogicProgram): [string, Json][] {
  const seen = new Set<string>()
  const events: [string, Json][] = [
    ['level.started', { title: 'T' }],
    ['level.questionLoaded', { index: 0, total: 1, row: 0 }],
  ]
  for (const rule of logic.rules) {
    if (seen.has(rule.on)) continue
    seen.add(rule.on)
    if (rule.on.startsWith('level.')) continue
    events.push([rule.on, {}])
  }
  events.push(['level.finished', { score: 0, passed: false }])
  return events
}

async function runV3(
  program: object,
  row: Json,
  script: [string, Json][],
  commands: { path: string; args: Json }[],
  errors: string[],
): Promise<Record<string, Json>> {
  const host: GraphHost = {
    getQuestion: () => row,
    dispatchCommand: (path, args) => commands.push({ path, args }),
    // 空 payload 下引用 event.* 的表达式会求值失败：v1 跳过该规则、v3 中断该处理器，
    // 对单规则等价（动作都不执行）。收集错误数量参与对比，不中断测试。
    onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
  }
  const engine = new GraphEngine(program as never, host)
  engine.vars.__row = 0 // 行门控装载子图依赖的系统变量（真实运行时由 LevelSession.loadRow 写入）
  for (const [event, payload] of script) {
    // docs/25 改名：v3 侧题目载入事件为 question.loaded（v1 引擎保持旧名不变）
    engine.dispatch(event === 'level.questionLoaded' ? 'question.loaded' : event, payload)
    // 排空 drain 与微任务（无 wait 节点的内置关卡即可收敛）
    for (let i = 0; i < 100; i++) await Promise.resolve()
  }
  return engine.vars
}

function runV1(
  logic: LogicProgram,
  row: Json,
  script: [string, Json][],
  commands: { path: string; args: Json }[],
  errors: string[],
  patchVars: Record<string, Json> | undefined,
): Record<string, Json> {
  const host: LogicHost = {
    getQuestion: () => row,
    dispatchCommand: (path, args) => commands.push({ path, args }),
    onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
  }
  const engine = new LogicEngine(logic, host)
  for (const [event, payload] of script) {
    // 旧运行时语义：题目装载时 logicPatch.variables merge 覆盖（v3 由行门控装载子图承担）
    if (event === 'level.questionLoaded' && patchVars) Object.assign(engine.vars, structuredClone(patchVars))
    engine.dispatch(event, payload)
  }
  return engine.vars
}

describe('行为等价 golden：内置关卡 v1 vs v3（表格行 + 行门控装载）双跑', () => {
  for (const [name, v1Doc, v3Doc] of SAMPLES) {
    it(`${name}：变量终态与命令序列一致`, async () => {
      const v1logic = v1Doc.content.logic as LogicProgram
      const migrated = migrateDocToV3(v1Doc)
      const program = migrated.content.logic

      // 迁移确定性：v1 夹具经 v3 迁移器的逻辑产物 == 已入库的主 sample 逻辑
      expect(v3Doc.content.logic).toEqual(program)

      const script = eventScript(v1logic)
      const row = firstRow(v1Doc)
      const patchVars = v1Doc.content.questions[0]?.logicPatch?.variables

      const recV1 = makeRecorder()
      const varsV1 = runV1(v1logic, row, script, recV1.commands, recV1.errors, patchVars)
      const recV3 = makeRecorder()
      const varsV3 = await runV3(program, row, script, recV3.commands, recV3.errors)
      delete varsV3.__row // 运行时簿记变量（行门控用），v1 侧无此键，不参与终态对比

      expect(varsV3).toEqual(varsV1)
      // 命令序列一致（docs/25 改名折算：v1 的 level.next 即 v3 的 question.next）
      const canon = (cs: { path: string; args: Json }[]) =>
        cs.map((c) => ({ ...c, path: c.path === 'level.next' ? 'question.next' : c.path }))
      expect(canon(recV3.commands)).toEqual(canon(recV1.commands))
      // 同样的表达式错误在两引擎中发生同样次数（规则跳过 vs 处理器中断，单规则等价）
      expect(recV3.errors).toHaveLength(recV1.errors.length)
    })
  }
})
