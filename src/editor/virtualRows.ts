/**
 * 数据表行虚拟化（docs/40 D1 / docs/43 §7 后续批次 R14）：
 * - 行高可变（行头下缘拖拽、按行号存于编辑器内存态）→ 用前缀和偏移表定位可视行；
 * - 纯函数、无 DOM 依赖，便于单测覆盖边界（空表/超滚动/精确边界/overscan）。
 *
 * 表格渲染只挂载「可视区 + overscan」的行：notes 单元格的 VexFlow 预览、单元格输入框
 * 与事件监听不再随行数线性增长（此前 512 行满配会全部挂载）。
 */

export interface RowMetrics {
  /** offsets[i] = 第 0..i-1 行的累计高度；offsets[rowCount] = 总高度 */
  offsets: number[]
  totalHeight: number
}

/** 按行高函数（可含用户拖拽覆盖）构建偏移表；行高非法值按 1px 兜底防止除零/负值 */
export function buildRowMetrics(rowCount: number, heightOf: (index: number) => number): RowMetrics {
  const offsets = new Array<number>(rowCount + 1)
  offsets[0] = 0
  for (let i = 0; i < rowCount; i += 1) {
    const h = heightOf(i)
    offsets[i + 1] = offsets[i] + (Number.isFinite(h) && h > 0 ? h : 1)
  }
  return { offsets, totalHeight: offsets[rowCount] }
}

/** 第一个满足 offsets[i] > y 的 i（i ∈ [0, rowCount]；空表返回 0） */
function firstOffsetGreater(offsets: number[], y: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] > y) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** 第一个满足 offsets[i] >= y 的 i（i ∈ [0, rowCount]；空表返回 0） */
function firstOffsetAtLeast(offsets: number[], y: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] >= y) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * 计算需挂载的行区间 [start, end)：
 * - scrollTop 夹到 [0, totalHeight]；
 * - viewportHeight <= 0 时按 1px 处理（jsdom 无布局，组件侧给 600px 兜底）；
 * - overscan 行数向两侧扩展，减少快速滚动白屏。
 */
export function visibleRowRange(
  metrics: RowMetrics,
  scrollTop: number,
  viewportHeight: number,
  overscan = 4,
): { start: number; end: number } {
  const rowCount = metrics.offsets.length - 1
  if (rowCount <= 0) return { start: 0, end: 0 }
  const top = Math.min(Math.max(scrollTop, 0), metrics.totalHeight)
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1
  const bottom = Math.min(top + height, metrics.totalHeight)
  // 首行：offsets 中最后一个 <= top 的行；top 恰在表尾时夹到最后一行
  const startRow = Math.min(Math.max(firstOffsetGreater(metrics.offsets, top) - 1, 0), rowCount - 1)
  // 末行（不含）：第一个 offsets >= bottom 的行；bottom 恰在行边界时正确排除下一行
  const endRow = Math.min(Math.max(firstOffsetAtLeast(metrics.offsets, bottom), startRow + 1), rowCount)
  const start = Math.max(0, startRow - Math.max(0, overscan))
  const end = Math.min(rowCount, endRow + Math.max(0, overscan))
  return { start, end }
}
