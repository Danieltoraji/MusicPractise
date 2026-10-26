/**
 * v4 伪代码编辑页（docs/53 §13.5；docs/52 W6.4）：图 IR 的第三投影。
 *
 * 唯一真源仍是文档（`doc.content.flow` / `<typeId>.behavior`）：
 * - 进入 / IR 变更时 `generateFlowScript` / `generateBehaviorScript` 重新生成文本；
 * - 「应用」= parse → 锚点合并（保留未改语句的节点 id/x/y）→ lint 预检 → onChange(next, tag)；
 * - 解析失败显示「行:列 + 中文消息」且文档不变；图超出结构化子集时显示可读降级说明；
 * - 文本与 IR 漂移（其它视图改过逻辑）用「基线签名 + 黄条」提示，不弹窗阻断。
 *
 * 组件既可独立挂载（props 与槽位同层：doc/onChange/revision + layer/typeId），
 * 也被 GraphWorkbench 内「图 / 伪代码」切换复用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BehaviorProgram, FlowProgram, LevelDocV4 } from '../../engine/v4/model'
import { getType } from '../../engine/v4/model'
import { lintLevelDocV4 } from '../../engine/v4/lint'
import {
  ScriptError,
  generateBehaviorScript,
  generateFlowScript,
  mergeBehaviorScriptAnchors,
  mergeFlowScriptAnchors,
  parseBehaviorScript,
  parseFlowScript,
} from '../../engine/v4/script'
import { updateBehavior, updateFlow } from './docStateV4'
import type { V4EditorSlotProps } from './shared'
import type { GraphLayer } from './graph/ops'

export interface ScriptTabV4Props extends V4EditorSlotProps {
  /** 投影层：flow main 或指定题型的 behavior */
  layer: GraphLayer
  /** behavior 层必填：题型 id */
  typeId?: string
}

const ID_PREFIX = 's'

interface ScriptDraft {
  text: string
  baseline: string
  baselineSig: string
  /** generate 失败（图超出伪代码结构化子集）的错误消息；null = 正常 */
  genError: string | null
}

/** 草稿缓存：编辑器 Tab/视图是条件渲染，切走即卸载——草稿必须跨视图存活。上限 20 份防跨关卡累积。 */
const drafts = new Map<string, ScriptDraft>()

/** IR 签名（剔除节点 x/y：位置变化不影响伪代码内容） */
function signatureOf(program: FlowProgram | BehaviorProgram): string {
  return JSON.stringify({
    ...program,
    nodes: program.nodes.map(({ id, kind, x, y, ...rest }) => ({ id, kind, ...rest })),
  })
}

function draftKey(doc: LevelDocV4, layer: GraphLayer, typeId: string | undefined): string {
  return `${doc.id}\u0000${layer}\u0000${typeId ?? ''}`
}

function currentProgram(doc: LevelDocV4, layer: GraphLayer, typeId: string | undefined): FlowProgram | BehaviorProgram | undefined {
  if (layer === 'flow') return doc.content.flow
  if (typeId === undefined) return undefined
  return getType(doc, typeId)?.behavior
}

function generate(program: FlowProgram | BehaviorProgram): ScriptDraft {
  try {
    const text = program.kind === 'flow' ? generateFlowScript(program) : generateBehaviorScript(program)
    return { text, baseline: text, baselineSig: signatureOf(program), genError: null }
  } catch (err) {
    return {
      text: '',
      baseline: '',
      baselineSig: '',
      genError: err instanceof Error ? err.message : String(err),
    }
  }
}

export function ScriptTabV4(props: ScriptTabV4Props): React.ReactElement {
  const { doc, layer, typeId } = props
  const program = currentProgram(doc, layer, typeId)
  const key = draftKey(doc, layer, typeId)

  const [draft, setDraft] = useState<ScriptDraft>(() => {
    const cached = drafts.get(key)
    if (cached) return cached
    return program !== undefined ? generate(program) : { text: '', baseline: '', baselineSig: '', genError: '目标层不存在' }
  })
  const [parseError, setParseError] = useState<ScriptError | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [appliedTip, setAppliedTip] = useState<string | null>(null)

  // 草稿持久缓存（卸载/切视图不丢）；切层/切文档时按 key 重新初始化
  useEffect(() => {
    drafts.set(key, draft)
    if (drafts.size > 20) {
      const oldest = drafts.keys().next().value
      if (oldest !== undefined && oldest !== key) drafts.delete(oldest)
    }
  }, [key, draft])

  // 切层/切文档：换草稿（同一 key 才复用）。用 ref 记录当前 key，避免把 program 变化误当成换层。
  const programRef = useRef(program)
  programRef.current = program
  const lastKeyRef = useRef(key)
  useEffect(() => {
    if (lastKeyRef.current === key) return
    lastKeyRef.current = key
    const cached = drafts.get(key)
    const active = programRef.current
    setDraft(cached ?? (active !== undefined ? generate(active) : { text: '', baseline: '', baselineSig: '', genError: '目标层不存在' }))
    setParseError(null)
    setApplyError(null)
    setAppliedTip(null)
  }, [key])

  const curSig = useMemo(() => (program !== undefined ? signatureOf(program) : ''), [program])
  const irStale = draft.baselineSig !== '' && draft.baselineSig !== curSig
  const textDirty = draft.text !== draft.baseline

  const regenerate = (): void => {
    if (program === undefined) return
    setDraft(generate(program))
    setParseError(null)
    setApplyError(null)
    setAppliedTip(null)
  }

  const apply = (): void => {
    if (program === undefined || draft.genError !== null) return
    try {
      const parsed =
        layer === 'flow' ? parseFlowScript(draft.text, { idPrefix: ID_PREFIX }) : parseBehaviorScript(draft.text, { idPrefix: ID_PREFIX })
      const merged =
        layer === 'flow'
          ? mergeFlowScriptAnchors(parsed as FlowProgram, program as FlowProgram)
          : mergeBehaviorScriptAnchors(parsed as BehaviorProgram, program as BehaviorProgram)
      const nextProgram = merged.program
      const nextDoc =
        layer === 'flow'
          ? updateFlow(doc, () => nextProgram as FlowProgram)
          : updateBehavior(doc, typeId as string, () => nextProgram as BehaviorProgram)
      // docs/53 §13.5：合并后跑 lint（errors/warnings 计数进提示；错误条由宿主 lintWarnings 统一展示）
      const issues = lintLevelDocV4(nextDoc)
      const errors = issues.filter((issue) => issue.level === 'error').length
      const warnings = issues.filter((issue) => issue.level === 'warning').length
      setParseError(null)
      setApplyError(null)
      setDraft({ text: draft.text, baseline: draft.text, baselineSig: signatureOf(nextProgram), genError: null })
      const summary = [`保留 ${merged.kept} 个节点 id/坐标`]
      if (merged.unmatched > 0) summary.push(`${merged.unmatched} 条改写/新增语句获得新 id`)
      if (merged.dropped > 0) summary.push(`丢弃 ${merged.dropped} 个未接线节点`)
      setAppliedTip(
        `已应用（${nextProgram.nodes.length} 节点 / ${nextProgram.edges.length} 连线；${summary.join('；')}；lint ${errors} 错 / ${warnings} 警告）`,
      )
      props.onChange(nextDoc, layer)
    } catch (err) {
      setAppliedTip(null)
      if (err instanceof ScriptError) {
        setParseError(err)
        setApplyError(null)
      } else {
        setParseError(null)
        setApplyError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const onTextareaKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    const element = event.currentTarget
    const { selectionStart, selectionEnd, value } = element
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
    setDraft((current) => ({ ...current, text: next }))
    requestAnimationFrame(() => {
      element.selectionStart = element.selectionEnd = selectionStart + 2
    })
  }, [])

  const stats = useMemo(() => ({ lines: draft.text === '' ? 0 : draft.text.split('\n').length }), [draft.text])
  const applyDisabled = program === undefined || draft.genError !== null || (irStale && !textDirty)
  const title = layer === 'flow' ? '流程 main 伪代码' : `题型行为伪代码${typeId !== undefined ? `（${typeId}）` : ''}`

  if (program === undefined) {
    return (
      <div className="script-tab v4-graph-script" data-testid="v4-graph-script">
        <div className="editor-errors" data-testid="v4-graph-script-error">
          目标层不存在{layer === 'behavior' ? `（题型「${typeId ?? ''}」）` : ''}，无法生成伪代码。
        </div>
      </div>
    )
  }

  return (
    <div className="script-tab v4-graph-script" data-testid="v4-graph-script">
      <div className="script-toolbar">
        <button type="button" className="primary" data-testid="v4-graph-script-apply" onClick={apply} disabled={applyDisabled}>
          应用到节点图
        </button>
        <button
          type="button"
          data-testid="v4-graph-script-regenerate"
          onClick={regenerate}
          disabled={draft.genError !== null}
          title="丢弃当前文本，从节点图重新生成"
        >
          从节点图重新生成
        </button>
        <span className="muted script-toolbar-hint">
          {title} · {stats.lines} 行 · 表达式与节点图同文；应用按语句特征保留节点 id 与坐标
        </span>
      </div>
      {parseError !== null && (
        <div className="editor-errors script-error" data-testid="v4-graph-script-error">
          解析失败：{parseError.message}
        </div>
      )}
      {applyError !== null && (
        <div className="editor-errors script-error" data-testid="v4-graph-script-error">
          应用未生效：{applyError}
        </div>
      )}
      {irStale && draft.genError === null && (
        <div className="editor-lint script-stale" data-testid="v4-graph-script-stale">
          {textDirty
            ? '节点图/JSON 中的逻辑已被修改，当前文本基于旧版本。'
            : '节点图/JSON 中的逻辑已被修改（当前文本无未应用修改）。'}
          <button type="button" onClick={regenerate}>
            重新生成（对齐节点图）
          </button>
          <button type="button" onClick={apply}>
            仍要应用当前文本（覆盖节点图）
          </button>
        </div>
      )}
      {draft.genError !== null && (
        <div className="editor-errors script-error" data-testid="v4-graph-script-error">
          当前逻辑图超出伪代码能表达的结构（{draft.genError}）——请在节点图中简化该结构，或查看 JSON。
        </div>
      )}
      {appliedTip !== null && (
        <div className="editor-saved" data-testid="v4-graph-script-tip">
          {appliedTip}
        </div>
      )}
      <textarea
        className="script-editor"
        spellCheck={false}
        data-testid="v4-graph-script-text"
        value={draft.text}
        disabled={draft.genError !== null}
        onChange={(event) => {
          setDraft((current) => ({ ...current, text: event.target.value }))
          setParseError(null)
        }}
        onKeyDown={onTextareaKeyDown}
      />
    </div>
  )
}
