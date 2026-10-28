/**
 * 编辑器路由入口（W9 后唯一路径）：`#/edit/:id` → 懒加载 EditorPageV4。
 * W6/W7/W8 的可插槽视图（流程图/行为图/画布/预览/AI 面板）在模块级 `V4_EDITOR_SLOTS`
 * 以稳定引用注册，避免 EditorPageV4 重渲染导致插槽子树重挂/预览会话重建。
 *
 * `#/edit/new` 的从零建关联：EditorPageV4 在首帧展示零代码模板选择条（W8.2）。
 */
import { lazy, Suspense } from 'react'
import type { V4EditorBehaviorSlotProps, V4EditorSlotProps } from './v4/shared'

const EditorPageV4 = lazy(() => import('./v4/EditorPageV4').then((m) => ({ default: m.EditorPageV4 })))
const FlowGraphSlotV4 = lazy(() =>
  import('./v4/graph/GraphWorkbench').then((m) => ({ default: m.FlowGraphSlot })),
)
const BehaviorGraphSlotV4 = lazy(() =>
  import('./v4/graph/GraphWorkbench').then((m) => ({ default: m.BehaviorGraphSlot })),
)
const ShellTabV4 = lazy(() => import('./v4/ShellTab').then((m) => ({ default: m.ShellTab })))
const PreviewTabV4 = lazy(() => import('./v4/PreviewTab').then((m) => ({ default: m.PreviewTab })))
const AiPanelV4 = lazy(() => import('./v4/AiPanelV4').then((m) => ({ default: m.AiPanelV4 })))

/** 槽位内层 Suspense：懒加载 chunk 只替换该区域，不把整个编辑器踢回 loading */
function slotWithFallback(node: React.ReactNode): React.ReactNode {
  return <Suspense fallback={<p className="muted page">加载编辑器视图…</p>}>{node}</Suspense>
}

/** 模块级稳定引用（避免每次渲染生成新函数） */
const V4_EDITOR_SLOTS = {
  renderFlow: (props: V4EditorSlotProps) => slotWithFallback(<FlowGraphSlotV4 {...props} />),
  renderBehavior: (props: V4EditorBehaviorSlotProps) => slotWithFallback(<BehaviorGraphSlotV4 {...props} />),
  renderShell: (props: V4EditorSlotProps) => slotWithFallback(<ShellTabV4 {...props} />),
  renderPreview: (props: V4EditorSlotProps) => slotWithFallback(<PreviewTabV4 {...props} />),
  renderAiPanel: (props: V4EditorSlotProps) => slotWithFallback(<AiPanelV4 {...props} />),
}

export function EditorPage({ id }: { id: string }) {
  return (
    <Suspense fallback={<p className="muted page">编辑器加载中…</p>}>
      <EditorPageV4 id={id} slots={V4_EDITOR_SLOTS} />
    </Suspense>
  )
}
