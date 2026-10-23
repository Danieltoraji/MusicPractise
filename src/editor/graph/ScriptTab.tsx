/**
 * 脚本页（3-3）：LevelScript 代码编辑视图——图 IR 的第三投影。
 * 唯一真源仍是 doc.content.logic：进入/IR 变更时 generateScript 重新生成文本；
 * 编辑后「应用」→ parseScript → IR 回写（变量保留、节点图重建）；解析失败显示行:列错误且 doc 不变。
 * 文本与 IR 的双向漂移用「基线签名 + 黄条」提示（重新生成 / 强制应用），不做弹窗阻断。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LevelDoc } from '../../engine/level'
import type { GraphProgram } from '../../engine/graphProgram'
import { generateScript, mergeScriptAnchors, parseScript, ScriptError } from '../../engine/script'

/** 脚本选区上报（行号 1 起；编辑器 AI 面板附带上下文用） */
export interface ScriptSelectionReport {
  startLine: number
  endLine: number
  text: string
}

interface Props {
  doc: LevelDoc
  onChange: (doc: LevelDoc) => void
  /** 文本选区变化上报（可选）；收起选区时上报 null */
  onSelectionReport?: (range: ScriptSelectionReport | null) => void
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

export function ScriptTab({ doc, onChange, onSelectionReport }: Props) {
  const program = doc.content.logic

  const [draft, setDraft] = useState<ScriptDraft>(() => {
    const cached = drafts.get(doc.id)
    if (cached) return cached
    return genDraft(program)
  })
  // 每次渲染派生陈旧判定（docs/40 E3）：缓存基线签名 ≠ 当前 IR 签名 = 其它视图改过逻辑。
  // 曾是一次性 useState 判定——AI 在脚本 Tab 保持挂载期间改逻辑时黄条永不出现，
  // 点「应用」会用旧文本静默覆盖 AI 写入。
  const curSig = useMemo(() => signatureOf(program), [program])
  const irStale = draft.baselineSig !== curSig
  const [parseError, setParseError] = useState<ScriptError | null>(null)
  /** 非解析类应用错误（合并结构自检失败等）：阻止应用并就地显示，不再静默吞掉 */
  const [applyError, setApplyError] = useState<string | null>(null)
  const [appliedTip, setAppliedTip] = useState<string | null>(null)

  // 草稿持久缓存（卸载/切 Tab 不丢）；经 effect 同步，避免渲染期副作用。
  // O4（docs/40）：上限 20 份防跨关卡累积（超出按插入序淘汰最旧）
  useEffect(() => {
    drafts.set(doc.id, draft)
    if (drafts.size > 20) {
      const oldest = drafts.keys().next().value
      if (oldest !== undefined && oldest !== doc.id) drafts.delete(oldest)
    }
  }, [doc.id, draft])

  const { text, genError } = draft
  const textDirty = text !== draft.baseline

  const regenerate = (): void => {
    const fresh = genDraft(program)
    setDraft(fresh)
    setParseError(null)
    setApplyError(null)
    setAppliedTip(null)
  }

  const apply = (): void => {
    if (genError) return
    try {
      const parsed = parseScript(text, { variables: program.variables, idPrefix: ID_PREFIX })
      // E1（docs/40）：锚点合并——按语句特征回填旧节点 id 与 x/y，不再整块重建。
      // 断点/AI 高亮/选中/布局不再因一次脚本应用而全部悬空丢失。
      // 返工（docs/42 §4.1/4.2）：未配对语句拿唯一新 id，旧节点无坐标时不写 undefined；
      // 合并自检失败会抛错 → 阻止应用并显示原因。
      const { prog, kept, unmatched, dropped } = mergeScriptAnchors(parsed, program)
      const nextSig = signatureOf(prog)
      setDraft({ text, baseline: text, baselineSig: nextSig, genError: null })
      setParseError(null)
      setApplyError(null)
      const summary = [`保留 ${kept} 节点 id/坐标`]
      if (unmatched > 0) summary.push(`${unmatched} 条改写语句获得新 id、坐标不保留`)
      if (dropped > 0) summary.push(`丢弃 ${dropped} 个未接线节点`)
      setAppliedTip(`已应用（${prog.nodes.length} 节点 / ${prog.edges.length} 连线；${summary.join('；')}）`)
      onChange({ ...doc, content: { ...doc.content, logic: prog } })
    } catch (e) {
      setAppliedTip(null)
      if (e instanceof ScriptError) {
        setParseError(e)
        setApplyError(null)
      } else {
        setParseError(null)
        setApplyError(e instanceof Error ? e.message : String(e))
      }
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

  // 选区上报（AI 面板上下文）：拖选/双击/Shift 方向键都会触发 select 事件
  const onTextareaSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
      if (!onSelectionReport) return
      const el = e.currentTarget
      const { selectionStart, selectionEnd, value } = el
      if (selectionStart === selectionEnd) {
        onSelectionReport(null)
        return
      }
      const startLine = value.slice(0, selectionStart).split('\n').length
      const endLine = startLine + value.slice(selectionStart, selectionEnd).split('\n').length - 1
      onSelectionReport({ startLine, endLine, text: value.slice(selectionStart, selectionEnd) })
    },
    [onSelectionReport],
  )

  // E1：应用将丢弃的不可达节点数（旧图可达序列之外的节点）——应用前明示而非静默删除
  const droppedCount = useMemo(() => {
    const byId = new Map(program.nodes.map((n) => [n.id, n]))
    const seen = new Set<string>()
    const visit = (id: string): void => {
      if (seen.has(id)) return
      const node = byId.get(id)
      if (!node) return
      seen.add(id)
      for (const e of program.edges.filter((x) => x.from === id)) visit(e.to)
    }
    for (const n of program.nodes) {
      if (n.kind !== 'on') continue
      visit(n.id)
      for (const e of program.edges.filter((x) => x.from === n.id && !x.port)) visit(e.to)
    }
    return program.nodes.length - seen.size
  }, [program])

  // E1-b（docs/42 返工）：应用前预览「改写/新增语句」数量（按未配对=将获得新 id）。
  // 解析失败（打字中间态）返回 null——此时应用本身会被解析错误拦截，只保留丢弃提示。
  const previewUnmatched = useMemo(() => {
    try {
      const parsed = parseScript(text, { variables: program.variables, idPrefix: ID_PREFIX })
      return mergeScriptAnchors(parsed, program).unmatched
    } catch {
      return null
    }
  }, [text, program])

  const preApplyHints: string[] = []
  if (droppedCount > 0) preApplyHints.push(`将丢弃 ${droppedCount} 个未接线节点（脚本只表达接线的执行链）`)
  if (previewUnmatched !== null && previewUnmatched > 0) {
    preApplyHints.push(`${previewUnmatched} 条改写/新增语句将获得新 id、坐标不保留`)
  }

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
          {stats.handlers} 个事件处理器 · {stats.lines} 行 · 表达式与节点图完全同文；应用按语句特征保留节点 id 与坐标
        </span>
      </div>
      {parseError && (
        <div className="editor-errors script-error">
          解析失败：第 {parseError.line} 行第 {parseError.col} 列——{parseError.message.replace(/^第 \d+ 行第 \d+ 列: /, '')}
        </div>
      )}
      {applyError && (
        <div className="editor-errors script-error">
          应用未生效：{applyError}
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
      {!genError && preApplyHints.length > 0 && (
        <div className="editor-lint script-stale">
          应用预览：{preApplyHints.join('；')}。（如需保留旧 id/坐标，请先在节点图中接线或调整）
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
        onSelect={onTextareaSelect}
      />
    </div>
  )
}

export default ScriptTab

function signatureOf(prog: GraphProgram): string {
  // 位置变化不影响脚本内容，签名剔除 x/y
  return JSON.stringify([prog.variables ?? {}, prog.nodes.map(({ id, kind, x, y, ...rest }) => ({ id, kind, ...rest })), prog.edges])
}
