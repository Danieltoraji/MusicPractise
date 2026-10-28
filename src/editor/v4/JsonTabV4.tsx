/**
 * v4 编辑器「JSON」Tab（docs/53 §13.3 JSON）：
 * - 层选择：整关卡 / shell / types / tables / manifest / run / flow / behavior:<typeId>；
 * - 应用一律先构造候选文档再走 `loadLevelDocV4` 全量预检（schema + 结构/引用 + lint），
 *   非法 JSON / 非法结构**拒绝且不污染 doc**（不调用 onApply）；
 * - 草稿陈旧门（沿用 v3 `JsonTab` 方案）：草稿基线签名 ≠ 当前层内容签名 → 黄条 + 禁用应用，
 *   须显式「从当前文档重新生成」；按 `docId:层` 存 draftStore，跨 Tab/卸载存活。
 */
import { useEffect, useMemo, useState } from 'react'
import type { Json } from '../../engine/expr'
import type { BehaviorProgram, FlowProgram, LevelDocV4 } from '../../engine/v4/model'
import { loadLevelDocV4 } from '../../library/validate'
import { isDraftStale, loadDraft, saveDraft } from '../draftStore'
import type { JsonDraft } from '../draftStore'
import { V4_TAGS } from './docStateV4'
import { errText, type V4TabProps } from './shared'

const DRAFT_PREFIX = 'v4-json:'

type JsonLayer = 'level' | 'shell' | 'types' | 'tables' | 'manifest' | 'run' | 'flow' | `behavior:${string}`

interface LayerOption {
  value: JsonLayer
  label: string
}

function layerOptions(doc: LevelDocV4): LayerOption[] {
  const options: LayerOption[] = [
    { value: 'level', label: '整关卡（保留 id/version）' },
    { value: 'shell', label: 'content.shell 画布' },
    { value: 'types', label: 'content.types 题型定义' },
    { value: 'tables', label: 'content.tables 实例表' },
    ...(doc.content.manifest !== undefined ? [{ value: 'manifest' as const, label: 'content.manifest 显式题单' }] : []),
    { value: 'run', label: 'content.run 运行配置' },
    { value: 'flow', label: 'content.flow 主流程' },
    ...doc.content.types.map((type) => ({ value: `behavior:${type.id}` as const, label: `behavior:${type.id} · ${type.name}` })),
  ]
  return options
}

/** 层当前值（null 表示该层不存在） */
function layerValue(doc: LevelDocV4, layer: JsonLayer): Json {
  if (layer === 'level') return doc as unknown as Json
  if (layer === 'shell') return doc.content.shell as unknown as Json
  if (layer === 'types') return doc.content.types as unknown as Json
  if (layer === 'tables') return doc.content.tables as unknown as Json
  if (layer === 'manifest') return (doc.content.manifest ?? null) as Json
  if (layer === 'run') return doc.content.run as unknown as Json
  if (layer === 'flow') return doc.content.flow as unknown as Json
  const typeId = layer.slice('behavior:'.length)
  return (doc.content.types.find((type) => type.id === typeId)?.behavior ?? null) as Json
}

/** 层签名：草稿陈旧判定（只取该层内容；保存/撤销等外部变更会改变签名）。
 * 整关卡层排除 id/version——保存升版与内置副本换 id 不改变内容，不得触发「草稿陈旧」误报
 * （与 v3 JsonTab 的 jsonDocSignature 同口径）。 */
function layerSignature(doc: LevelDocV4, layer: JsonLayer): string {
  if (layer === 'level') return JSON.stringify({ meta: doc.meta, refs: doc.refs, content: doc.content })
  return JSON.stringify(layerValue(doc, layer))
}

function formatJson(value: Json): string {
  return JSON.stringify(value, null, 2)
}

type ApplyResult = { ok: true; doc: LevelDocV4 } | { ok: false; errors: string[] }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把某一层的 JSON 替换进当前文档（结构校验交给 loadLevelDocV4） */
function applyLayerValue(doc: LevelDocV4, layer: JsonLayer, parsed: unknown): ApplyResult {
  if (layer === 'level') {
    if (!isObject(parsed)) return { ok: false, errors: ['整关卡层必须是 JSON 对象'] }
    return { ok: true, doc: parsed as unknown as LevelDocV4 }
  }
  const content = { ...doc.content }
  if (layer === 'shell') {
    if (!isObject(parsed)) return { ok: false, errors: ['shell 层必须是 JSON 对象'] }
    content.shell = parsed as never
  } else if (layer === 'types') {
    if (!Array.isArray(parsed)) return { ok: false, errors: ['types 层必须是 JSON 数组'] }
    content.types = parsed as never
  } else if (layer === 'tables') {
    if (!isObject(parsed)) return { ok: false, errors: ['tables 层必须是 JSON 对象（题型 id → 实例表）'] }
    content.tables = parsed as never
  } else if (layer === 'manifest') {
    if (parsed === null) {
      const rest = {
        shell: content.shell,
        types: content.types,
        tables: content.tables,
        run: content.run,
        flow: content.flow,
      }
      return { ok: true, doc: { ...doc, content: rest } }
    }
    if (!isObject(parsed)) return { ok: false, errors: ['manifest 层必须是 JSON 对象或 null（null = 自动题单）'] }
    content.manifest = parsed as never
  } else if (layer === 'run') {
    if (!isObject(parsed)) return { ok: false, errors: ['run 层必须是 JSON 对象'] }
    content.run = parsed as never
  } else if (layer === 'flow') {
    if (!isObject(parsed)) return { ok: false, errors: ['flow 层必须是 JSON 对象'] }
    content.flow = parsed as unknown as FlowProgram
  } else if (layer.startsWith('behavior:')) {
    const typeId = layer.slice('behavior:'.length)
    const index = content.types.findIndex((type) => type.id === typeId)
    if (index < 0) return { ok: false, errors: [`题型 "${typeId}" 已不存在，请从当前文档重新生成`] }
    if (!isObject(parsed)) return { ok: false, errors: [`behavior:${typeId} 层必须是 JSON 对象`] }
    const types = content.types.slice()
    types[index] = { ...types[index], behavior: parsed as unknown as BehaviorProgram }
    content.types = types
  } else {
    return { ok: false, errors: [`未知 JSON 层：${layer}`] }
  }
  return { ok: true, doc: { ...doc, content } }
}

export function JsonTabV4({ doc, onChange }: V4TabProps): React.ReactElement {
  const options = useMemo(() => layerOptions(doc), [doc])
  const [layer, setLayer] = useState<JsonLayer>('level')
  const initialSig = layerSignature(doc, 'level')
  const [draft, setDraft] = useState<JsonDraft>(() => {
    const cached = loadDraft<JsonDraft>(doc.id, `${DRAFT_PREFIX}level`)
    return cached ?? { text: formatJson(layerValue(doc, 'level')), baselineSig: initialSig }
  })
  const [error, setError] = useState('')

  const currentSig = useMemo(() => layerSignature(doc, layer), [doc, layer])
  const stale = isDraftStale(draft, currentSig)

  // 草稿持久化：按 docId:层 键控（切 Tab / 卸载后回来仍在）
  useEffect(() => {
    saveDraft(doc.id, `${DRAFT_PREFIX}${layer}`, draft)
  }, [doc.id, layer, draft])

  const regenerate = (nextLayer: JsonLayer = layer): void => {
    setDraft({ text: formatJson(layerValue(doc, nextLayer)), baselineSig: layerSignature(doc, nextLayer) })
    setError('')
  }

  const switchLayer = (next: JsonLayer): void => {
    const cached = loadDraft<JsonDraft>(doc.id, `${DRAFT_PREFIX}${next}`)
    const sig = layerSignature(doc, next)
    setLayer(next)
    setDraft(cached ?? { text: formatJson(layerValue(doc, next)), baselineSig: sig })
    setError('')
  }

  const apply = (): void => {
    if (stale) {
      setError('草稿基于旧版本——先「从当前文档重新生成」再应用')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(draft.text)
    } catch (err) {
      setError(`不是合法 JSON：${errText(err)}`)
      return
    }
    const candidate = applyLayerValue(doc, layer, parsed)
    if (!candidate.ok) {
      setError(candidate.errors.join('\n'))
      return
    }
    // 整关卡保留当前 id/version（改 id 会另存新记录，与 URL/库脱节）
    if (layer === 'level') {
      candidate.doc.id = doc.id
      candidate.doc.version = doc.version
    }
    const result = loadLevelDocV4(candidate.doc)
    if (!result.ok) {
      setError(result.errors.slice(0, 12).join('\n'))
      return
    }
    onChange(result.doc, V4_TAGS.json)
    setDraft({ text: formatJson(layerValue(result.doc, layer)), baselineSig: layerSignature(result.doc, layer) })
    setError('')
  }

  return (
    <div className="json-tab v4-json-tab" data-testid="v4-json-tab">
      <div className="v4-json-bar">
        <label className="v4-field v4-json-layer">
          <span>编辑层</span>
          <select
            value={layer}
            data-testid="v4-json-layer"
            onChange={(e) => switchLayer(e.target.value as JsonLayer)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="primary" data-testid="v4-json-apply" onClick={apply} disabled={stale}>
          应用 JSON 到编辑器
        </button>
        <button type="button" data-testid="v4-json-regenerate" onClick={() => regenerate()}>
          从当前文档重新生成
        </button>
        <span className="muted">
          应用前会走 loadLevelDocV4 全量预检（schema + 引用 + lint）；失败不会修改文档。
        </span>
      </div>
      {stale && (
        <div className="editor-lint v4-warn" data-testid="v4-json-stale">
          文档已被其它操作修改（当前 JSON 草稿基于旧版本，直接应用会覆盖新修改）。
          <button type="button" onClick={() => regenerate()}>
            从当前文档重新生成
          </button>
        </div>
      )}
      {error && (
        <pre className="tone-error v4-json-error" data-testid="v4-json-error">
          {error}
        </pre>
      )}
      <textarea
        className="v4-json-textarea"
        rows={24}
        value={draft.text}
        spellCheck={false}
        data-testid="v4-json-textarea"
        onChange={(e) => setDraft((current) => ({ ...current, text: e.target.value }))}
      />
    </div>
  )
}
