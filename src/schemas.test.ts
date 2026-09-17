/**
 * Schema 一致性测试：示例关卡文档必须通过 JSON Schema 校验。
 * 导入管线与编辑器将共用这套 schema（Ajv）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020'
import noteClickDoc from './sample/note-click.level.json'
import theoryChoiceDoc from './sample/theory-choice.level.json'
import melodyDictationDoc from './sample/melody-dictation.level.json'
import timedReactionDoc from './sample/timed-reaction.level.json'
import noteSpellingDoc from './sample/note-spelling.level.json'

const SCHEMA_FILES = ['common.json', 'logic.json', 'level.json', 'series.json', 'topic.json', 'instrument.json']
const BASE = 'https://music-practise.local/schemas/v1/'

function buildAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  for (const file of SCHEMA_FILES) {
    const raw = readFileSync(new URL(`../schemas/v1/${file}`, import.meta.url), 'utf8')
    ajv.addSchema(JSON.parse(raw))
  }
  return ajv
}

describe('关卡文档 JSON Schema', () => {
  const ajv = buildAjv()
  const validate = ajv.getSchema(`${BASE}level.json`)
  it('schema 已注册且可编译', () => {
    expect(validate).toBeDefined()
  })

  it('示例关卡 note-click 通过校验', () => {
    const ok = validate!(noteClickDoc)
    expect(validate!.errors ?? []).toEqual([])
    expect(ok).toBe(true)
  })

  it('示例关卡 theory-choice 通过校验', () => {
    const ok = validate!(theoryChoiceDoc)
    expect(validate!.errors ?? []).toEqual([])
    expect(ok).toBe(true)
  })

  it.each([
    ['melody-dictation', melodyDictationDoc],
    ['timed-reaction', timedReactionDoc],
    ['note-spelling', noteSpellingDoc],
  ])('示例关卡 %s 通过校验（含数组变量初值）', (_name, doc) => {
    const ok = validate!(doc)
    expect(validate!.errors ?? []).toEqual([])
    expect(ok).toBe(true)
  })

  it('坏文档被拒绝（kind 错误 + 缺 content）', () => {
    const bad = { ...(noteClickDoc as object), kind: 'series' }
    expect(validate!(bad)).toBe(false)
  })

  it('坏规则被拒绝（emit 事件名不合法）', () => {
    const bad = structuredClone(noteClickDoc)
    bad.content.logic.rules[0].do = [{ emit: 'no-colon' } as unknown as never]
    expect(validate!(bad)).toBe(false)
  })

  it('坏规则被拒绝（单段 on 是死规则）', () => {
    const bad = structuredClone(noteClickDoc)
    bad.content.logic.rules[0].on = 'bare'
    expect(validate!(bad)).toBe(false)
  })

  it('动作参数 "$100" 被拒绝（非合法引用形态）', () => {
    const bad = structuredClone(noteClickDoc)
    bad.content.logic.rules[0].do = [
      { cmd: 'feedback.show', args: { text: '$100' } } as unknown as never,
    ]
    expect(validate!(bad)).toBe(false)
  })

  it('Note 定义：16n/32n 合法、3n 非法、vel 0..127（拒绝旧 0..1 语义）', () => {
    // q.data 是自由 JSON 不受 schema 约束，故直接对 common.json 的 Note 定义校验
    const noteSchema = ajv.compile({ allOf: [{ $ref: `${BASE}common.json#/$defs/Note` }] })
    expect(noteSchema({ midi: 64, dur: '16n' })).toBe(true)
    expect(noteSchema({ midi: 64, dur: '32n.' })).toBe(true)
    expect(noteSchema({ midi: 64, dur: '3n' })).toBe(false)
    expect(noteSchema({ midi: 64, vel: 100 })).toBe(true)
    expect(noteSchema({ midi: 64, vel: 127 })).toBe(true)
    expect(noteSchema({ midi: 64, vel: 0.8 })).toBe(false)
    expect(noteSchema({ midi: 64, vel: 200 })).toBe(false)
  })

  it('组件 id 保留字 level 被拒绝', () => {
    const bad = structuredClone(noteClickDoc)
    bad.content.components[0].id = 'level'
    expect(validate!(bad)).toBe(false)
  })

  describe('其余 kind 的正例', () => {
    const compile = (kind: string) => ajv.getSchema(`${BASE}${kind}.json`)!

    it('series', () => {
      const doc = {
        schemaVersion: 1,
        kind: 'series',
        id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A3',
        version: '1.0.0',
        meta: { title: '乐理入门系列' },
        refs: [{ id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A4', kind: 'topic', version: '^1.0.0' }],
        content: { topicIds: ['res_01J9A0A0A0A0A0A0A0A0A0A0A4'] },
      }
      expect(compile('series')(doc)).toBe(true)
    })

    it('topic', () => {
      const doc = {
        schemaVersion: 1,
        kind: 'topic',
        id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A4',
        version: '1.0.0',
        meta: { title: '练耳' },
        refs: [],
        content: { levelIds: ['res_01J9A0A0A0A0A0A0A0A0A0A0A1'], brief: '' },
      }
      expect(compile('topic')(doc)).toBe(true)
    })

    it('instrument：fretboard 与 keyboard', () => {
      const fretboard = {
        schemaVersion: 1,
        kind: 'instrument',
        id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A5',
        version: '1.0.0',
        meta: { title: '民谣吉他' },
        content: {
          type: 'fretboard',
          tuning: [{ midi: 40 }, { midi: 45 }, { midi: 50 }, { midi: 55 }, { midi: 59 }, { midi: 64 }],
          frets: 12,
          noteMap: { '64': [{ string: 1, fret: 0 }] },
          shapes: { 'C': [{ string: 2, fret: 1 }] },
        },
      }
      expect(compile('instrument')(fretboard)).toBe(true)

      const keyboard = {
        schemaVersion: 1,
        kind: 'instrument',
        id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A6',
        version: '1.0.0',
        meta: { title: '61键电子琴' },
        content: {
          type: 'keyboard',
          keyCount: 61,
          noteMap: { '60': [{ key: 30 }] },
        },
      }
      expect(compile('instrument')(keyboard)).toBe(true)
    })
  })
})
