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
  /** JSON Tab 未应用文本 */
  jsonText: 'json-text',
  /** 数据表列宽/行高布局态 */
  tableLayout: 'table-layout',
  /** AI 面板输入框草稿 */
  aiInput: 'ai-input',
  /** 画布当前视图 */
  canvasView: 'canvas-view',
} as const
