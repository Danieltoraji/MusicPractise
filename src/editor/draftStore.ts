/**
 * 编辑器草稿注册表（docs/40 C1 / §12.2）：编辑器五 Tab 条件渲染切走即卸载，
 * 组件内 state 的「会话内保持」不成立——统一在模块级 Map 按 `docId:slot` 键控跨卸载存活。
 * 这是 ScriptTab drafts（自带基线签名的先行实现）的通用化：读（挂载初始化）/
 * 写（变更时）/ 清（应用或重置）三个操作；stale 检测（foreign 变更提示）由各
 * 消费方按需叠加——ScriptTab 的 baselineSig 模式是参考蓝本。
 * 生命周期：随编辑器页面存活（SPA 会话内）；docId 换档自然隔离，不做 TTL。
 */

const drafts = new Map<string, unknown>()

export function loadDraft<T>(docId: string, slot: string): T | undefined {
  return drafts.get(`${docId}:${slot}`) as T | undefined
}

export function saveDraft(docId: string, slot: string, value: unknown): void {
  drafts.set(`${docId}:${slot}`, value)
}

export function clearDraft(docId: string, slot: string): void {
  drafts.delete(`${docId}:${slot}`)
}

/** 草稿槽位常量（消费方与测试共用，防拼写漂移） */
export const DRAFT_SLOTS = {
  /** JSON Tab 未应用文本（值为 {@link JsonDraft}：文本 + 挂载基线签名） */
  jsonText: 'json-text',
  /** 数据表列宽/行高布局态 */
  tableLayout: 'table-layout',
  /** AI 面板输入框草稿 */
  aiInput: 'ai-input',
  /** 画布当前视图 */
  canvasView: 'canvas-view',
} as const

/**
 * 带基线签名的文本草稿（JSON Tab，docs/42 §5.1-13 草稿 stale）：
 * baselineSig = 挂载时文档结构签名；当前文档签名与之不一致 = 文档已被其它操作
 * （AI 写入/undo/其它 Tab）修改过 → 黄条提示 + 禁用应用，须显式「从当前文档重新生成」。
 */
export interface JsonDraft {
  text: string
  baselineSig: string
}

/** 草稿基线是否陈旧：基线签名 ≠ 当前文档结构签名（渲染期派生，挂载后外部修改同样能检测） */
export function isDraftStale(draft: Pick<JsonDraft, 'baselineSig'>, currentSig: string): boolean {
  return draft.baselineSig !== currentSig
}

/**
 * 草稿换档（docs/42 §4.6 C5）：内置示例另存副本后 doc.id 变更，按 `docId:slot` 键控的
 * 全部草稿（JSON 文本/表格布局/AI 输入框/画布视图）迁移到新 id，避免同挂载内草稿失联。
 * 其它文档的草稿不受影响。
 */
export function renameDrafts(oldDocId: string, newDocId: string): void {
  if (oldDocId === newDocId) return
  const prefix = `${oldDocId}:`
  for (const key of [...drafts.keys()]) {
    if (!key.startsWith(prefix)) continue
    drafts.set(`${newDocId}:${key.slice(prefix.length)}`, drafts.get(key))
    drafts.delete(key)
  }
}
