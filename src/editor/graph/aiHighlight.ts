/**
 * AI 节点高亮（批次5）：AI 与创作者的交互通道——
 * highlight_nodes 工具设置高亮集合，节点卡发光 + 自动画布定位，创作者一眼看到 AI 在说哪个节点。
 * 模块级单例 + 可订阅快照（同 debugRun 惯例）。
 */

const listeners = new Set<() => void>()
let snapshot: { ids: string[]; note: string | null } = { ids: [], note: null }

function notify(): void {
  for (const fn of listeners) fn()
}

export function subscribeAiHighlight(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getAiHighlight(): { ids: string[]; note: string | null } {
  return snapshot
}

/** 设置高亮（空 ids = 清除）；替换式（每次高亮表达一个焦点） */
export function setAiHighlight(ids: string[], note: string | null = null): void {
  snapshot = { ids: [...ids], note }
  notify()
}

export function clearAiHighlight(): void {
  if (snapshot.ids.length === 0 && snapshot.note === null) return
  snapshot = { ids: [], note: null }
  notify()
}
