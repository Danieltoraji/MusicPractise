/**
 * v4 编辑器「画布」Tab（docs/53 §13.3 画布；W13 起与题型内画布同源，docs/57）：
 * shell 视图管理 + 组件画布 —— 本文件只做层适配，画布实现全部在 `CanvasEditor`。
 *
 * 与 surface 画布的差异（全部经 props 注入 CanvasEditor）：
 * - 组件层 = shell（跨题常驻）；绑定根 = `v / run`（只读投影）；
 * - 预览环境 = flow.vars 初值 + 空题单投影；
 * - 视图至少保留一个（minViews=1），删除视图时其组件一并移除（docStateV4.removeView 语义）；
 * - 撤销 tag = 'shell'（连续画布操作合并为一条撤销步）。
 *
 * 写路径全部走 docStateV4 纯函数族（结构共享 + 程序化 id + 撤销 tag），本文件不直接
 * 构造 LevelDocV4、不原地修改组件。运行归属（docs/40 §12.4）：本 Tab 不持有会话/计时器。
 */
import { useMemo } from 'react'
import type { Json } from '../../engine/expr'
import { SHELL_BINDING_ROOTS } from '../../engine/v4/expr'
import { SCHEMA_LIMITS_V4, type ComponentInstanceV4 } from '../../engine/v4/model'
import {
  SHELL_LAYER,
  addComponent,
  addView,
  removeComponent,
  removeView,
  updateComponent,
  updateShell,
  updateView,
} from './docStateV4'
import { buildShellPreviewEnv } from './canvasPreview'
import { CanvasEditor } from './CanvasEditor'
import type { CanvasLayout } from './canvasPreview'
import type { V4EditorSlotProps } from './shared'

/** 画布撤销 tag：连续 shell 操作合并为一条撤销步（与 v3「同 tag 连续合并」语义一致） */
const SHELL_TAG = 'shell'

export function ShellTab({ doc, onChange, revision }: V4EditorSlotProps): React.ReactElement {
  const shell = doc.content.shell
  const previewEnv = useMemo<Record<string, Json>>(() => buildShellPreviewEnv(doc), [doc.content.flow.vars])

  const addWithView = (type: string, viewId: string, layout: CanvasLayout): string => {
    const result = addComponent(doc, SHELL_LAYER, type, { view: viewId === '' ? undefined : viewId, layout })
    onChange(result.doc, SHELL_TAG)
    return result.id
  }

  const patchComponent = (componentId: string, patch: Partial<ComponentInstanceV4>): void => {
    onChange(updateComponent(doc, SHELL_LAYER, componentId, patch), SHELL_TAG)
  }

  return (
    <div className="v4-shell-tab" data-testid="v4-shell-tab" data-revision={revision}>
      <CanvasEditor
        layer="shell"
        title="shell 画布"
        subtitle={`视图 ${shell.views.length}/${SCHEMA_LIMITS_V4.views} · 组件 ${shell.components.length}/${SCHEMA_LIMITS_V4.shellComponents} · 跨题常驻`}
        components={shell.components}
        views={shell.views}
        initialView={shell.initialView}
        componentsLimit={SCHEMA_LIMITS_V4.shellComponents}
        viewsLimit={SCHEMA_LIMITS_V4.views}
        minViews={1}
        allowAllViews={false}
        bindingRoots={SHELL_BINDING_ROOTS}
        bindingHint="可用 v / run"
        previewEnv={previewEnv}
        onAddComponent={addWithView}
        onUpdateComponent={patchComponent}
        onRemoveComponent={(componentId) => onChange(removeComponent(doc, SHELL_LAYER, componentId), SHELL_TAG)}
        onAddView={() => {
          const result = addView(doc)
          onChange(result.doc, SHELL_TAG)
          return result.id
        }}
        onRenameView={(viewId, name) => onChange(updateView(doc, viewId, { name }), SHELL_TAG)}
        onRemoveView={(viewId) => {
          const next = removeView(doc, viewId)
          if (next !== doc) onChange(next, SHELL_TAG)
        }}
        onSetInitialView={(viewId) => onChange(updateShell(doc, (current) => ({ ...current, initialView: viewId })), SHELL_TAG)}
      />
    </div>
  )
}
