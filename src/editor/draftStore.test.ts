// draftStore（docs/40 C1 / R4）：编辑器草稿注册表——跨 Tab 卸载存活的统一键控存储
import { describe, expect, it } from 'vitest'
import { clearDraft, DRAFT_SLOTS, loadDraft, saveDraft } from './draftStore'

describe('draftStore', () => {
  it('save/load 按 docId:slot 键控读写', () => {
    saveDraft('docA', DRAFT_SLOTS.jsonText, '{ "a": 1 }')
    expect(loadDraft<string>('docA', DRAFT_SLOTS.jsonText)).toBe('{ "a": 1 }')
    expect(loadDraft('docB', DRAFT_SLOTS.jsonText)).toBeUndefined() // 不同 doc 隔离
    expect(loadDraft('docA', DRAFT_SLOTS.aiInput)).toBeUndefined() // 不同槽隔离
  })

  it('clearDraft 移除后读不到；重复 clear 幂等', () => {
    saveDraft('docC', DRAFT_SLOTS.tableLayout, { colW: { x: 1 } })
    clearDraft('docC', DRAFT_SLOTS.tableLayout)
    expect(loadDraft('docC', DRAFT_SLOTS.tableLayout)).toBeUndefined()
    expect(() => clearDraft('docC', DRAFT_SLOTS.tableLayout)).not.toThrow()
  })
})
