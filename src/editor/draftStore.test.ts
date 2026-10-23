// draftStore（docs/40 C1 / R4）：编辑器草稿注册表——跨 Tab 卸载存活的统一键控存储
// R13（docs/42 §5.1-13 / §4.6 C5）：JSON 草稿基线 stale 判定 + 内置副本换 id 的槽位迁移
import { describe, expect, it } from 'vitest'
import {
  clearDraft,
  DRAFT_SLOTS,
  isDraftStale,
  loadDraft,
  renameDrafts,
  saveDraft,
  type JsonDraft,
} from './draftStore'

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

  it('renameDrafts（C5）：全部槽位随文档换 id 迁移，旧 id 清空，其它文档/前缀不误伤', () => {
    saveDraft('old', DRAFT_SLOTS.jsonText, { text: '{"a":1}', baselineSig: 'sig-1' } satisfies JsonDraft)
    saveDraft('old', DRAFT_SLOTS.tableLayout, { colW: { a: 1 } })
    saveDraft('old', DRAFT_SLOTS.aiInput, '未发送的提问')
    saveDraft('old', DRAFT_SLOTS.canvasView, 'view2')
    saveDraft('other', DRAFT_SLOTS.aiInput, '别人的草稿')
    saveDraft('older', DRAFT_SLOTS.aiInput, '前缀相似但不同文档')

    renameDrafts('old', 'new')

    expect(loadDraft<JsonDraft>('new', DRAFT_SLOTS.jsonText)).toEqual({ text: '{"a":1}', baselineSig: 'sig-1' })
    expect(loadDraft('new', DRAFT_SLOTS.tableLayout)).toEqual({ colW: { a: 1 } })
    expect(loadDraft('new', DRAFT_SLOTS.aiInput)).toBe('未发送的提问')
    expect(loadDraft('new', DRAFT_SLOTS.canvasView)).toBe('view2')
    // 旧 id 全部槽位清空（否则下次切回旧文档会读到副本的草稿）
    expect(loadDraft('old', DRAFT_SLOTS.jsonText)).toBeUndefined()
    expect(loadDraft('old', DRAFT_SLOTS.tableLayout)).toBeUndefined()
    expect(loadDraft('old', DRAFT_SLOTS.aiInput)).toBeUndefined()
    expect(loadDraft('old', DRAFT_SLOTS.canvasView)).toBeUndefined()
    // 其它文档（含前缀相似名）不受影响
    expect(loadDraft('other', DRAFT_SLOTS.aiInput)).toBe('别人的草稿')
    expect(loadDraft('older', DRAFT_SLOTS.aiInput)).toBe('前缀相似但不同文档')
    // 同 id 迁移是 no-op
    renameDrafts('new', 'new')
    expect(loadDraft('new', DRAFT_SLOTS.aiInput)).toBe('未发送的提问')
  })

  it('isDraftStale（草稿 stale）：基线签名与当前文档签名不一致才陈旧', () => {
    const draft: JsonDraft = { text: '{}', baselineSig: 'sig-doc-v1' }
    expect(isDraftStale(draft, 'sig-doc-v1')).toBe(false)
    expect(isDraftStale(draft, 'sig-doc-v2')).toBe(true) // 文档被 AI/undo/其它 Tab 修改
    // 「从当前文档重新生成」= 基线签名前移到当前文档 → 不再 stale
    const regenerated: JsonDraft = { text: '{"b":2}', baselineSig: 'sig-doc-v2' }
    expect(isDraftStale(regenerated, 'sig-doc-v2')).toBe(false)
  })
})
