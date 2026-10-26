/**
 * v4 编辑器组件共用小件：Tab props 类型 + 通用 JSON 编辑弹窗。
 * （避免 ContentTab/ManifestTab/TypesTab 各自复制一份弹窗与错误文案转换。）
 */
import { useState } from 'react'
import type { Json } from '../../engine/expr'
import type { LevelDocV4 } from '../../engine/v4/model'
import { Modal } from '../Modal'

/** v4 各 Tab 的共同 props（宿主 = V4EditorShell / EditorPageV4） */
export interface V4TabProps {
  doc: LevelDocV4
  /** 单一更新入口：next 必须来自 docStateV4 纯函数；tag 用于撤销栈连续性合并 */
  onChange: (next: LevelDocV4, tag?: string) => void
}

/** 可插槽区域的公共 props（流程/舞台/预览/AI 面板） */
export interface V4EditorSlotProps extends V4TabProps {
  /** 文档修订号（AI 冲突检测 / 调试面板可读；宿主同步递增） */
  revision: number
}

/** 行为图工作台插槽 props（题型内编辑） */
export interface V4EditorBehaviorSlotProps extends V4EditorSlotProps {
  typeId: string
}

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * 通用 JSON 编辑弹窗：空文本 = null（清空语义）；非法 JSON 就地报错不应用。
 * testId 前缀用于区分不同弹窗（data-testid={`${testId}-text`} / `${testId}-apply`）。
 */
export function JsonEditModal(props: {
  title: string
  value: Json
  hint?: string
  rows?: number
  testId?: string
  onApply: (value: Json) => void
  onClose: () => void
}): React.ReactElement {
  const testId = props.testId ?? 'v4-json-edit'
  const [text, setText] = useState(() => (props.value === undefined || props.value === null ? '' : JSON.stringify(props.value, null, 2)))
  const [error, setError] = useState('')
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      actions={
        <>
          <button type="button" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            data-testid={`${testId}-apply`}
            onClick={() => {
              const trimmed = text.trim()
              if (trimmed === '') {
                props.onApply(null)
                return
              }
              try {
                props.onApply(JSON.parse(trimmed) as Json)
              } catch {
                setError('不是合法 JSON')
              }
            }}
          >
            应用
          </button>
        </>
      }
    >
      {error && (
        <div className="tone-error" data-testid={`${testId}-error`}>
          {error}
        </div>
      )}
      {props.hint && <p className="muted">{props.hint}</p>}
      <textarea
        rows={props.rows ?? 12}
        value={text}
        spellCheck={false}
        data-testid={`${testId}-text`}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
    </Modal>
  )
}
