/**
 * 脚本页（3-3）：LevelScript 代码编辑视图——图 IR 的第三投影。
 * 唯一真源仍是 doc.content.logic：进入/IR 变更时 generateScript 重新生成文本；
 * 编辑后「应用」→ parseScript → IR 回写（变量保留、节点图重建）；解析失败显示行:列错误且 doc 不变。
 * 文本与 IR 的双向漂移用「基线签名 + 黄条」提示（重新生成 / 强制应用），不做弹窗阻断。
 */
import { useCallback, useMemo, useState } from 'react'
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
}
const drafts = new Map<string, ScriptDraft>()

export function ScriptTab({ doc, onChange }: Props) {
  const program = doc.content.logic

  const [text, setText] = useState(() => drafts.get(doc.id)?.text ?? generateScript(program))
  const [baseline, setBaseline] = useState(() => drafts.get(doc.id)?.baseline ?? text)
  const [baselineSig, setBaselineSig] = useState(() => drafts.get(doc.id)?.baselineSig ?? signatureOf(program))
  // 挂载时判定：缓存基线 ≠ 当前 IR → 其它视图改过逻辑
  const [irStale] = useState(() => {
    const cached = drafts.get(doc.id)
    return cached ? cached.baselineSig !== signatureOf(program) : false
  })
  const [parseError, setParseError] = useState<ScriptError | null>(null)
  const [appliedTip, setAppliedTip] = useState<string | null>(null)

  // 草稿持久缓存（卸载/切 Tab 不丢）
  drafts.set(doc.id, { text, baseline, baselineSig })

  const textDirty = text !== baseline

  const regenerate = (): void => {
    const fresh = generateScript(program)
    setBaseline(fresh)
    setBaselineSig(signatureOf(program))
    setText(fresh)
    setParseError(null)
    setAppliedTip(null)
    drafts.set(doc.id, { text: fresh, baseline: fresh, baselineSig: signatureOf(program) })
  }

  const apply = (): void => {
    try {
      const next = parseScript(text, { variables: program.variables, idPrefix: ID_PREFIX })
      const nextSig = signatureOf(next)
      setBaselineSig(nextSig)
      setBaseline(text)
      setParseError(null)
      setAppliedTip(`已应用（${next.nodes.length} 节点 / ${next.edges.length} 连线；节点图已按脚本重建）`)
      drafts.set(doc.id, { text, baseline: text, baselineSig: nextSig })
      onChange({ ...doc, content: { ...doc.content, logic: next } })
    } catch (e) {
      if (e instanceof ScriptError) setParseError(e)
      else setParseError(new ScriptError(e instanceof Error ? e.message : String(e), 0, 0))
    }
  }

  const onTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (!(e.key === 'Tab')) return
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart, selectionEnd, value } = el
      const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
      setText(next)
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

  return (
    <div className="script-tab">
      <div className="script-toolbar">
        <button type="button" className="primary" onClick={apply} disabled={!textDirty && !irStale && !parseError}>
          应用到节点图
        </button>
        <button type="button" onClick={regenerate} title="丢弃当前文本，从节点图重新生成脚本">
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
      {irStale && textDirty && (
        <div className="editor-lint script-stale">
          节点图/JSON 中的逻辑已被修改，当前文本基于旧版本。
          <button type="button" onClick={regenerate}>
            重新生成（丢弃文本）
          </button>
          <button type="button" onClick={apply}>
            仍要应用当前文本（覆盖节点图）
          </button>
        </div>
      )}
      {appliedTip && <div className="editor-saved">{appliedTip}</div>}
      <textarea
        className="script-editor"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
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
