/**
 * 脚本页（3-3）：LevelScript 代码编辑视图——图 IR 的第三投影。
 * 唯一真源仍是 doc.content.logic：进入/IR 变更时 generateScript 重新生成文本；
 * 编辑后「应用」→ parseScript → IR 回写（变量保留、节点图重建）；解析失败显示行:列错误且 doc 不变。
 * 文本与 IR 的双向漂移用「基线签名 + 黄条」提示（重新生成 / 强制应用），不做弹窗阻断。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LevelDoc } from '../../engine/level'
import type { GraphProgram } from '../../engine/graphProgram'
import { generateScript, parseScript, ScriptError } from '../../engine/script'

interface Props {
  doc: LevelDoc
  onChange: (doc: LevelDoc) => void
}

/** 应用解析产物的节点 id 前缀（脚本重建的图与节点图手搭的 n1、迁移的 rule_on 可区分来源） */
const ID_PREFIX = 's'

/**
 * 草稿缓存（按 doc.id）：编辑器各 Tab 是条件渲染，切走即卸载——
 * 草稿必须跨 Tab 存活（否则打到一半的字在切节点图时全丢）。
 * baselineSig 记录文本基线对应的 IR 版本：重挂时若当前 IR 签名不同，
 * 说明其它视图改过逻辑 → 黄条提示（文本保留，由用户选择重新生成或覆盖）。
 */
interface ScriptDraft {
  text: string
  baseline: string
  baselineSig: string
  /** generateScript 失败（图超出伪代码结构化子集）时的错误消息；null = 正常 */
  genError: string | null
}
const drafts = new Map<string, ScriptDraft>()

function genDraft(prog: GraphProgram): ScriptDraft {
  try {
    const baseline = generateScript(prog)
    return { text: baseline, baseline, baselineSig: signatureOf(prog), genError: null }
  } catch (err) {
    // 图超出伪代码结构化子集（多路径汇入/循环体不回头等）：可读降级，不白屏
    return {
      text: '',
      baseline: '',
      baselineSig: '',
      genError: err instanceof Error ? err.message : String(err),
    }
  }
}

export function ScriptTab({ doc, onChange }: Props) {
  const program = doc.content.logic

  const [draft, setDraft] = useState<ScriptDraft>(() => {
    const cached = drafts.get(doc.id)
    if (cached) return cached
    return genDraft(program)
  })
  // 挂载时判定：缓存基线 ≠ 当前 IR → 其它视图（节点图/JSON）改过逻辑，文本已过期
  const [irStale, setIrStale] = useState<boolean>(() => {
    const cached = drafts.get(doc.id)
    return cached ? cached.baselineSig !== signatureOf(program) : false
  })
  const [parseError, setParseError] = useState<ScriptError | null>(null)
  const [appliedTip, setAppliedTip] = useState<string | null>(null)

  // 草稿持久缓存（卸载/切 Tab 不丢）；经 effect 同步，避免渲染期副作用
  useEffect(() => {
    drafts.set(doc.id, draft)
  }, [doc.id, draft])

  const { text, genError } = draft
  const textDirty = text !== draft.baseline

  const regenerate = (): void => {
    const fresh = genDraft(program)
    setDraft(fresh)
    setIrStale(false)
    setParseError(null)
    setAppliedTip(null)
    void fresh
  }

  const apply = (): void => {
    if (genError) return
    try {
      const next = parseScript(text, { variables: program.variables, idPrefix: ID_PREFIX })
      const nextSig = signatureOf(next)
      setDraft({ text, baseline: text, baselineSig: nextSig, genError: null })
      setIrStale(false)
      setParseError(null)
      setAppliedTip(`已应用（${next.nodes.length} 节点 / ${next.edges.length} 连线；节点图已按脚本重建）`)
      onChange({ ...doc, content: { ...doc.content, logic: next } })
    } catch (e) {
      if (e instanceof ScriptError) setParseError(e)
      else setParseError(null)
    }
  }

  const onTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (!(e.key === 'Tab')) return
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart, selectionEnd, value } = el
      const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
      setDraft((d) => ({ ...d, text: next }))
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = selectionStart + 2
      })
    },
    [],
  )

  const stats = useMemo(() => {
    const handlers = (text.match(/^on /gm) ?? []).length
    return { handlers, lines: text.split('\n').length }
  }, [text])

  // 陈旧且文本干净：无可应用的旧文本（应用=静默覆盖新 IR），禁用；须先编辑或重新生成
  const applyDisabled = !!genError || (irStale && !textDirty)

  return (
    <div className="script-tab">
      <div className="script-toolbar">
        <button type="button" className="primary" onClick={apply} disabled={applyDisabled}>
          应用到节点图
        </button>
        <button type="button" onClick={regenerate} disabled={!!genError} title="丢弃当前文本，从节点图重新生成脚本">
          从节点图重新生成
        </button>
        <span className="muted script-toolbar-hint">
          {stats.handlers} 个事件处理器 · {stats.lines} 行 · 表达式与节点图完全同文；应用将按脚本重建节点图（变量保留）
        </span>
      </div>
      {parseError && (
        <div className="editor-errors script-error">
          解析失败：第 {parseError.line} 行第 {parseError.col} 列——{parseError.message.replace(/^第 \d+ 行第 \d+ 列: /, '')}
        </div>
      )}
      {irStale && !genError && (
        <div className="editor-lint script-stale">
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
      {genError && (
        <div className="editor-errors script-error">
          当前逻辑图超出伪代码能表达的结构（{genError}）——请在节点图中简化该结构，或查看 JSON。
        </div>
      )}
      {appliedTip && <div className="editor-saved">{appliedTip}</div>}
      <textarea
        className="script-editor"
        spellCheck={false}
        value={text}
        disabled={!!genError}
        onChange={(e) => {
          setDraft((d) => ({ ...d, text: e.target.value }))
          setParseError(null) // 编辑即清除旧错误定位（P2-1）
        }}
        onKeyDown={onTextareaKeyDown}
      />
    </div>
  )
}

export default ScriptTab

function signatureOf(prog: GraphProgram): string {
  // 位置变化不影响脚本内容，签名剔除 x/y
  return JSON.stringify([prog.variables ?? {}, prog.nodes.map(({ id, kind, x, y, ...rest }) => ({ id, kind, ...rest })), prog.edges])
}
