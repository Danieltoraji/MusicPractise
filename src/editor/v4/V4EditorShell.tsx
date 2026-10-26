/**
 * v4 编辑器外壳（docs/53 §13.3 Tab IA）：props 驱动的纯表现层壳。
 *
 * - 头部：返回 / 标题（tag='title'）/ 撤销重做 / 保存 / 修订号；
 * - Tab：content 内容 · flow 流程 · types 题型 · shell 舞台 · preview 预览 · json JSON
 *   （`data-testid=editor-tab-<id>`，G3 锚点契约）；
 * - 可插槽 props：`renderFlow` / `renderBehavior` / `renderShell` / `renderPreview` / `renderAiPanel`
 *   —— W6（图工作台）与 W7（舞台/预览/AI 调试）通过 fork 的槽位实现接入，本壳只提供占位；
 * - 宿主（EditorPageV4）负责文档状态、撤销栈、保存、脏标与 lint，本壳不持有文档真源。
 *
 * 复用 v3 既有编辑器 chrome 样式类（`.editor-head` / `.editor-tabs` / `.editor-body` 等），
 * 因此 v4 不需要复制一套编辑器外壳样式；增量样式只在 `v4-editor.css`。
 */
import { useState } from 'react'
import type { LevelDocV4 } from '../../engine/v4/model'
import { ErrorBoundary } from '../../library/ErrorBoundary'
import { EDITOR_HOOKS } from '../editorHooks'
import { ContentTab } from './ContentTab'
import { JsonTabV4 } from './JsonTabV4'
import { TypesTab } from './TypesTab'
import { V4_TAGS, withMeta } from './docStateV4'
import type { V4EditorBehaviorSlotProps, V4EditorSlotProps, V4TabProps } from './shared'

/** v4 编辑器 Tab id（顺序 = Tab 栏渲染顺序；docs/53 §13.3） */
export type V4EditorTab = 'content' | 'flow' | 'types' | 'shell' | 'preview' | 'json'

export const V4_EDITOR_TABS: { id: V4EditorTab; label: string }[] = [
  { id: 'content', label: '内容' },
  { id: 'flow', label: '流程' },
  { id: 'types', label: '题型' },
  { id: 'shell', label: '舞台' },
  { id: 'preview', label: '预览' },
  { id: 'json', label: 'JSON' },
]

// 槽位 props 类型定义在 shared.tsx（TypesTab 也要用，避免 shell ↔ tab 类型环）
export type { V4EditorBehaviorSlotProps, V4EditorSlotProps, V4TabProps }

/**
 * 可插槽区域（W6/W7 接入点）：
 * - flow → GraphWorkbench flow 模式（W6）
 * - behavior → GraphWorkbench behavior 模式（W6，在「题型 → 行为」子页内）
 * - shell → ShellTab 舞台编辑（W7）
 * - preview → PreviewTab 游玩+调试（W7）
 * - aiPanel → AiPanel v4 适配（W8）
 */
export interface V4EditorSlots {
  renderFlow?: (props: V4EditorSlotProps) => React.ReactNode
  renderBehavior?: (props: V4EditorBehaviorSlotProps) => React.ReactNode
  renderShell?: (props: V4EditorSlotProps) => React.ReactNode
  renderPreview?: (props: V4EditorSlotProps) => React.ReactNode
  renderAiPanel?: (props: V4EditorSlotProps) => React.ReactNode
}

export interface V4EditorShellProps extends V4EditorSlots {
  doc: LevelDocV4
  /** 单一更新入口（来自 EditorPageV4.update：入撤销栈 + 标脏 + revision 自增） */
  onChange: (next: LevelDocV4, tag?: string) => void
  /** 保存动作（可返回任意值；壳内 `void` 调用，不关心结果） */
  onSave: () => unknown
  dirty: boolean
  revision: number
  lintWarnings: string[]
  saving?: boolean
  saveErrors?: string[]
  savedTip?: string
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** 宿主渲染的横幅区（外部修改提示 / 加载告警等） */
  banner?: React.ReactNode
  /** AI 面板开关：受控（传 onToggleAi）或不传则由壳内管 */
  aiOpen?: boolean
  onToggleAi?: () => void
  activeTab?: V4EditorTab
  onTabChange?: (tab: V4EditorTab) => void
  onTryRun?: () => void
  backHref?: string
  /** 头部右侧额外动作（宿主/后续批次插入） */
  headerExtra?: React.ReactNode
}

const PLACEHOLDER: Record<'flow' | 'shell' | 'preview', string> = {
  flow: '流程（Flow main 图工作台）将在 W6 接入：图 / 伪代码切换、调色板、检查器、预设、lint 面板。',
  shell: '舞台（shell 视图与组件画布）将在 W7 接入：视图管理、拖放/缩放、属性与绑定编辑、组件预览。',
  preview: '预览（v4 游玩画面 + 调试面板）将在 W7 接入：调用栈 / 四层作用域 / 牌堆 / 日志 / 每题返回。',
}

export function V4EditorShell(props: V4EditorShellProps): React.ReactElement {
  const [innerTab, setInnerTab] = useState<V4EditorTab>('content')
  const [innerAiOpen, setInnerAiOpen] = useState(true)
  const tab = props.activeTab ?? innerTab
  const aiOpen = props.aiOpen ?? innerAiOpen
  const slotProps: V4EditorSlotProps = { doc: props.doc, onChange: props.onChange, revision: props.revision }

  const switchTab = (next: V4EditorTab): void => {
    props.onTabChange?.(next)
    if (props.activeTab === undefined) setInnerTab(next)
  }
  const toggleAi = (): void => {
    if (props.onToggleAi) props.onToggleAi()
    else setInnerAiOpen((open) => !open)
  }

  return (
    <div className="page editor v4-editor" data-testid="v4-editor" data-revision={props.revision}>
      <div className="editor-narrow-tip">
        ⚠ 当前窗口较窄：部分面板可能被隐藏。编辑器建议在 ≥1100px 宽的窗口使用。
      </div>
      <div className="editor-head">
        <a href={props.backHref ?? '#/library'}>← 资源库</a>
        <input
          className="editor-title"
          data-testid="editor-title"
          value={String(props.doc.meta.title ?? '')}
          onChange={(e) => props.onChange(withMeta(props.doc, { title: e.target.value }), V4_TAGS.title)}
        />
        <span className="editor-head-group">
          <button
            type="button"
            data-testid="editor-undo"
            disabled={props.canUndo === false || props.canUndo === undefined}
            title="撤销（Ctrl+Z）"
            onClick={() => props.onUndo?.()}
          >
            ↶
          </button>
          <button
            type="button"
            data-testid="editor-redo"
            disabled={props.canRedo === false || props.canRedo === undefined}
            title="重做（Ctrl+Shift+Z / Ctrl+Y）"
            onClick={() => props.onRedo?.()}
          >
            ↷
          </button>
        </span>
        <span className="editor-head-group">
          <button
            type="button"
            className="primary"
            data-testid="editor-save"
            disabled={props.saving === true}
            onClick={() => void props.onSave()}
          >
            {props.saving ? '保存中…' : `💾 保存${props.dirty ? ' *' : ''}`}
          </button>
          {props.onTryRun && (
            <button type="button" data-testid="editor-try-run" onClick={() => props.onTryRun?.()}>
              ▶ 试运行
            </button>
          )}
          <span className="muted v4-revision" title="文档修订号（AI 冲突检测用）" data-testid="v4-editor-revision">
            rev {props.revision}
          </span>
          {props.headerExtra}
        </span>
      </div>

      {props.banner}

      {props.saveErrors !== undefined && props.saveErrors.length > 0 && (
        <div className="editor-errors" data-testid="editor-save-errors">
          <b>无法保存，请修正：</b>
          <ul>
            {props.saveErrors.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {props.lintWarnings.length > 0 && (
        <div className="editor-lint" data-testid="editor-lint">
          ⚠ lint（{props.lintWarnings.length}）：{props.lintWarnings.slice(0, 5).join('；')}
          {props.lintWarnings.length > 5 ? ' …' : ''}
        </div>
      )}
      {props.savedTip !== undefined && props.savedTip !== '' && (
        <div className="editor-saved" data-testid="editor-saved-tip">
          {props.savedTip}
        </div>
      )}

      <div className="editor-tabs">
        {V4_EDITOR_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={`editor-tab-${item.id}`}
            className={tab === item.id ? 'active' : ''}
            onClick={() => switchTab(item.id)}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          data-testid="editor-ai-toggle"
          className={`editor-ai-toggle${aiOpen ? ' active' : ''}`}
          title="AI 助手（W8 v4 适配后接入）"
          onClick={toggleAi}
        >
          🤖 AI
        </button>
      </div>

      <div className={EDITOR_HOOKS.editorBody}>
        <ErrorBoundary title="编辑器区域出错">
          {tab === 'content' && <ContentTab doc={props.doc} onChange={props.onChange} />}
          {tab === 'types' && (
            <TypesTab
              doc={props.doc}
              onChange={props.onChange}
              revision={props.revision}
              renderBehavior={props.renderBehavior}
            />
          )}
          {tab === 'json' && <JsonTabV4 key={props.doc.id} doc={props.doc} onChange={props.onChange} />}
          {tab === 'flow' && (
            <div className="v4-tab-fill" data-testid="v4-flow-area">
              {props.renderFlow ? (
                props.renderFlow(slotProps)
              ) : (
                <div className="v4-placeholder" data-testid="v4-flow-placeholder">
                  {PLACEHOLDER.flow}
                </div>
              )}
            </div>
          )}
          {tab === 'shell' && (
            <div className="v4-tab-fill" data-testid="v4-shell-area">
              {props.renderShell ? (
                props.renderShell(slotProps)
              ) : (
                <div className="v4-placeholder" data-testid="v4-shell-placeholder">
                  {PLACEHOLDER.shell}
                </div>
              )}
            </div>
          )}
          {tab === 'preview' && (
            <div className="v4-tab-fill" data-testid="v4-preview-area">
              {props.renderPreview ? (
                props.renderPreview(slotProps)
              ) : (
                <div className="v4-placeholder" data-testid="v4-preview-placeholder">
                  {PLACEHOLDER.preview}
                </div>
              )}
            </div>
          )}
        </ErrorBoundary>

        {aiOpen && (
          <aside className="ai-panel v4-ai-panel" data-testid="v4-ai-panel">
            {props.renderAiPanel ? (
              props.renderAiPanel(slotProps)
            ) : (
              <div className="v4-placeholder" data-testid="v4-ai-placeholder">
                AI 助手面板将在 W8 v4 适配后接入（当前编辑器写路径已全部走 update 单一入口，可被 AI 工具复用）。
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
