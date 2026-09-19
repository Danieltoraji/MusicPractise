/**
 * 行为等价 golden：8 个内置关卡 v1（LogicEngine）vs v2（GraphEngine 双跑）。
 * 交互脚本自动生成（收集 v1 程序的全部事件入口逐一派发），对比变量终态与命令序列。
 * 另断言迁移器确定性：migrate(v1 夹具) 与已转换入库的主 sample 逐字段一致。
 */
import { describe, expect, it } from 'vitest'
import type { LogicProgram } from './logic'
import { LogicEngine, type LogicHost } from './logic'
import { GraphEngine, type GraphHost } from './graphEngine'
import { migrateLogicV1toV2 } from './migrate'
import type { Json } from './expr'

import noteClickV1 from '../sample/fixtures/note-click.v1.json'
import theoryChoiceV1 from '../sample/fixtures/theory-choice.v1.json'
import melodyDictationV1 from '../sample/fixtures/melody-dictation.v1.json'
import timedReactionV1 from '../sample/fixtures/timed-reaction.v1.json'
import noteSpellingV1 from '../sample/fixtures/note-spelling.v1.json'
import clefTestV1 from '../sample/fixtures/clef-test.v1.json'
import rhythmFollowV1 from '../sample/fixtures/rhythm-follow.v1.json'
import tuneIntroV1 from '../sample/fixtures/tune-intro.v1.json'

import noteClickV2 from '../sample/note-click.level.json'
import theoryChoiceV2 from '../sample/theory-choice.level.json'
import melodyDictationV2 from '../sample/melody-dictation.level.json'
import timedReactionV2 from '../sample/timed-reaction.level.json'
import noteSpellingV2 from '../sample/note-spelling.level.json'
import clefTestV2 from '../sample/clef-test.level.json'
import rhythmFollowV2 from '../sample/rhythm-follow.level.json'
import tuneIntroV2 from '../sample/tune-intro.level.json'

type V1Doc = { content: { components: { id: string }[]; logic: unknown; questions: { id: string; data: Json; scoring?: Json }[] } }
type V2Doc = { content: { logic: unknown } }
const SAMPLES: [string, V1Doc, V2Doc][] = [
  ['note-click', noteClickV1, noteClickV2],
  ['theory-choice', theoryChoiceV1, theoryChoiceV2],
  ['melody-dictation', melodyDictationV1, melodyDictationV2],
  ['timed-reaction', timedReactionV1, timedReactionV2],
  ['note-spelling', noteSpellingV1, noteSpellingV2],
  ['clef-test', clefTestV1, clefTestV2],
  ['rhythm-follow', rhythmFollowV1, rhythmFollowV2],
  ['tune-intro', tuneIntroV1, tuneIntroV2],
]

function makeRecorder() {
  const commands: { path: string; args: Json }[] = []
  const errors: string[] = []
  return { commands, errors }
}

/** 表达式里会读 q.data.*：用真实第一题对象作为作用域 q，两引擎一致 */
function firstQuestion(doc: V1Doc): Json {
  return (doc.content.questions[0] ?? { id: 'q1', data: {} }) as Json
}

/** 收集 v1 程序的事件入口并生成派发脚本（空 payload；生命周期事件用真实负载） */
function eventScript(logic: LogicProgram): [string, Json][] {
  const seen = new Set<string>()
  const events: [string, Json][] = [['level.started', { title: 'T' }], ['level.questionLoaded', { index: 0, total: 1 }]]
  for (const rule of logic.rules) {
    if (seen.has(rule.on)) continue
    seen.add(rule.on)
    if (rule.on.startsWith('level.')) continue
    events.push([rule.on, {}])
  }
  events.push(['level.finished', { score: 0, passed: false }])
  return events
}

async function runV2(
  logic: LogicProgram,
  question: Json,
  script: [string, Json][],
  commands: { path: string; args: Json }[],
  errors: string[],
): Promise<Record<string, Json>> {
  const host: GraphHost = {
    getQuestion: () => question,
    dispatchCommand: (path, args) => commands.push({ path, args }),
    // 空 payload 下引用 event.* 的表达式会求值失败：v1 跳过该规则、v2 中断该处理器，
    // 对单规则等价（动作都不执行）。收集错误数量参与对比，不中断测试。
    onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
  }
  const engine = new GraphEngine(logic, host)
  for (const [event, payload] of script) {
    engine.dispatch(event, payload)
    // 排空 drain 与微任务（无 wait 节点的内置关卡即可收敛）
    for (let i = 0; i < 100; i++) await Promise.resolve()
  }
  return engine.vars
}

function runV1(
  logic: LogicProgram,
  question: Json,
  script: [string, Json][],
  commands: { path: string; args: Json }[],
  errors: string[],
): Record<string, Json> {
  const host: LogicHost = {
    getQuestion: () => question,
    dispatchCommand: (path, args) => commands.push({ path, args }),
    onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
  }
  const engine = new LogicEngine(logic, host)
  for (const [event, payload] of script) engine.dispatch(event, payload)
  return engine.vars
}

describe('行为等价 golden：内置关卡 v1 vs v2 双跑', () => {
  for (const [name, v1Doc, v2Doc] of SAMPLES) {
    it(`${name}：变量终态与命令序列一致`, async () => {
      const v1logic = v1Doc.content.logic as LogicProgram
      const v2program = migrateLogicV1toV2(v1logic)

      // 迁移确定性：v1 夹具的迁移产物 == 已入库的主 sample 逻辑
      expect(v2Doc.content.logic).toEqual(v2program)

      const script = eventScript(v1logic)
      const question = firstQuestion(v1Doc)

      const recV1 = makeRecorder()
      const varsV1 = runV1(v1logic, question, script, recV1.commands, recV1.errors)
      const recV2 = makeRecorder()
      const varsV2 = await runV2(v1logic, question, script, recV2.commands, recV2.errors)

      expect(varsV2).toEqual(varsV1)
      expect(recV2.commands).toEqual(recV1.commands)
      // 同样的表达式错误在两引擎中发生同样次数（规则跳过 vs 处理器中断，单规则等价）
      expect(recV2.errors).toHaveLength(recV1.errors.length)
    })
  }
})
