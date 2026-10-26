/**
 * 游玩舞台几何常量（v4）：800×470 设计坐标系 + fit-scale 纯函数。
 * 原 `runtime/LevelStage.tsx` 为 v3 渲染组件；v4 拆出几何定义供 LevelStageV4 复用
 * （W9 删除 v3 舞台时保留此文件，避免 v4 依赖已退役组件）。
 */

export const STAGE_W = 800
export const STAGE_H = 470

/** G11（docs/44 R26）：纯函数 fit 计算，便于单测边界/稳定性（宽 0 兜底 scale 0，保持既有语义） */
export function computeStageFit(width: number): { scale: number; left: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 0
  const scale = Math.min(1, w / STAGE_W)
  return { scale, left: Math.max(0, (w - STAGE_W * scale) / 2) }
}
