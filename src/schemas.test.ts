/**
 * Schema 一致性测试（v4）：内置关卡样例必须通过 JSON Schema 校验。
 * 运行时校验用 @cfworker/json-schema（CSP 禁 eval，见 src/library/validate.ts docs/34）；
 * 本测试在 Node（无 CSP）中用 Ajv2020 交叉验证同一组 schema——双校验器一致才算过。
 * series/topic/instrument 仍走 schemas/v1。
 */
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020'
import { SCHEMA_BASE, SCHEMA_BASE_V4, SCHEMA_RAW } from './library/validate'
import { loadLevelDoc, validateEnvelope } from './library/validate'
import noteClickDoc from './sample/note-click.level.json'
import theoryChoiceDoc from './sample/theory-choice.level.json'
import melodyDictationDoc from './sample/melody-dictation.level.json'
import timedReactionDoc from './sample/timed-reaction.level.json'
import noteSpellingDoc from './sample/note-spelling.level.json'
import clefTestDoc from './sample/clef-test.level.json'
import rhythmFollowDoc from './sample/rhythm-follow.level.json'
import tuneIntroDoc from './sample/tune-intro.level.json'
import tutorialHelloDoc from './sample/tutorial-hello.level.json'
import synthLabDoc from './sample/synth-lab.level.json'
import starterSeries from './sample/starter.series.json'
import starterTopic1 from './sample/starter-topic1.topic.json'
import starterTopic2 from './sample/starter-topic2.topic.json'

const LEVEL_ID = `${SCHEMA_BASE_V4}level.json`
const BASE = SCHEMA_BASE

const ajv = new Ajv2020({ strict: false, allErrors: true })
for (const schema of SCHEMA_RAW) {
  ajv.addSchema(schema as never)
}

const SAMPLES: [string, unknown][] = [
  ['note-click', noteClickDoc],
  ['theory-choice', theoryChoiceDoc],
  ['melody-dictation', melodyDictationDoc],
  ['timed-reaction', timedReactionDoc],
  ['note-spelling', noteSpellingDoc],
  ['clef-test', clefTestDoc],
  ['rhythm-follow', rhythmFollowDoc],
  ['tune-intro', tuneIntroDoc],
  ['tutorial-hello', tutorialHelloDoc],
  ['synth-lab', synthLabDoc],
]

describe('v4 关卡 JSON Schema', () => {
  const validate = ajv.getSchema(LEVEL_ID)
  it('v4 level schema 已注册且可编译，cfworker 装载管线可用', () => {
    expect(validate).toBeDefined()
    expect(validateEnvelope('level', noteClickDoc).ok).toBe(true)
  })

  it('示例系列与专题通过 v1 校验', () => {
    for (const doc of [starterSeries, starterTopic1, starterTopic2]) {
      const kind = (doc as { kind: string }).kind
      const v = ajv.getSchema(`${BASE}${kind}.json`)!
      expect(v(doc)).toBe(true)
      expect(v.errors ?? []).toEqual([])
    }
  })

  it.each(SAMPLES)('示例关卡 %s 通过 v4 schema（Ajv）', (_name, doc) => {
    const ok = validate!(doc)
    expect(validate!.errors ?? []).toEqual([])
    expect(ok).toBe(true)
  })

  it.each(SAMPLES)('示例关卡 %s 通过 cfworker 装载（含结构/引用/lint）', (_name, doc) => {
    const r = validateEnvelope('level', doc)
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('旧 schemaVersion 被 v4 schema 拒绝', () => {
    const bad = { ...(noteClickDoc as object), schemaVersion: 3 }
    expect(validate!(bad)).toBe(false)
  })

  it('缺 content.flow / content.types 被拒绝', () => {
    const noFlow = JSON.parse(JSON.stringify(noteClickDoc)) as { content: Record<string, unknown> }
    delete noFlow.content.flow
    expect(validate!(noFlow)).toBe(false)
    const noTypes = JSON.parse(JSON.stringify(noteClickDoc)) as { content: Record<string, unknown> }
    delete noTypes.content.types
    expect(validate!(noTypes)).toBe(false)
  })

  it('未知节点 kind 被 schema 拒绝', () => {
    const bad = JSON.parse(JSON.stringify(noteClickDoc)) as {
      content: { flow: { nodes: { kind: string }[] } }
    }
    bad.content.flow.nodes[0].kind = 'nope'
    expect(validate!(bad)).toBe(false)
  })

  it('非法表达式根被语义 lint 捕获为告警（装载放行，编辑器可打开修复）', () => {
    const bad = JSON.parse(JSON.stringify(noteClickDoc)) as {
      content: { flow: { nodes: { kind: string; value?: { expr?: string } }[] } }
    }
    const assign = bad.content.flow.nodes.find((node) => node.kind === 'assign')
    expect(assign).toBeDefined()
    assign!.value = { expr: 'q.row' } // v4 flow 层不存在 q. 根
    const r = loadLevelDoc(bad)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lintWarnings.length).toBeGreaterThan(0)
  })
})
