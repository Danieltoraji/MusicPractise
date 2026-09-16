/**
 * Schema 一致性测试：示例关卡文档必须通过 JSON Schema 校验。
 * 导入管线与编辑器将共用这套 schema（Ajv）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020'
import noteClickDoc from './sample/note-click.level.json'
import theoryChoiceDoc from './sample/theory-choice.level.json'

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

  it('坏文档被拒绝（kind 错误 + 缺 content）', () => {
    const bad = { ...(noteClickDoc as object), kind: 'series' }
    expect(validate!(bad)).toBe(false)
  })

  it('坏规则被拒绝（emit 事件名不合法）', () => {
    const bad = structuredClone(noteClickDoc)
    bad.content.logic.rules[0].do = [{ emit: 'no-colon' } as unknown as never]
    expect(validate!(bad)).toBe(false)
  })
})
