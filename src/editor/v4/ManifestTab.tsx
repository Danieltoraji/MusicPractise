/**
 * v4 编辑器「题单与运行」子页（docs/53 §13.3 内容 → manifest）：
 * - 自动题单只读预览（draft 排除 + phase/order/题型序/行序排序说明）；
 * - 显式题单编辑（entry 增删/重排/args）+ 草稿引用警告 + 重复槽位警告；
 * - run 配置（order/count/seed/shuffleWithinPhase）；
 * - 牌堆预览（buildDeck；固定 seed 时复现，null 时用预览 seed 模拟「本局随机」）。
 */
import { useMemo, useState } from 'react'
import type { Json } from '../../engine/expr'
import {
  SCHEMA_LIMITS_V4,
  type DeckItem,
  type LevelDocV4,
  type ManifestEntry,
  type RunConfig,
} from '../../engine/v4/model'
import { buildAutoManifest, buildDeck, type ManifestBuild } from '../../engine/v4/manifest'
import { V4_TAGS, findRow, setManifest, setRunConfig, typeName } from './docStateV4'
import { JsonEditModal, errText, type V4TabProps } from './shared'

/** 行的人类可读标签：首个文本列的值，缺省回落行 id */
function rowLabel(doc: LevelDocV4, typeId: string, rowId: string): string {
  const row = findRow(doc, typeId, rowId)
  if (!row) return `${rowId}（引用悬空）`
  for (const column of doc.content.tables[typeId]?.columns ?? []) {
    const value = row[column.key]
    if (typeof value === 'string' && value.trim() !== '') return value
    if (Array.isArray(value) && value.length > 0) return value.map((item) => String(item)).join('/')
  }
  return rowId
}

function slotCountLabel(slots: ManifestBuild['slots']): string {
  return slots.length === 0 ? '空题单' : `${slots.length} 项`
}

export function ManifestTab({ doc, onChange }: V4TabProps): React.ReactElement {
  const run = doc.content.run
  const manifest = doc.content.manifest
  const autoSlots = useMemo(() => buildAutoManifest(doc), [doc])
  const [previewSeed, setPreviewSeed] = useState(1)
  const [error, setError] = useState('')
  const [argsEdit, setArgsEdit] = useState<{ index: number; value: Json } | null>(null)
  const [newTypeId, setNewTypeId] = useState('')
  const [newRowId, setNewRowId] = useState('')

  const deckBuild = useMemo(() => {
    try {
      return { ok: true as const, value: buildDeck(doc, { seed: run.seed ?? previewSeed }) }
    } catch (err) {
      return { ok: false as const, error: errText(err) }
    }
  }, [doc, run.seed, previewSeed])

  const entries: ManifestEntry[] = manifest?.entries ?? []
  const draftRefs = manifest
    ? entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => findRow(doc, entry.type, entry.row)?.draft === true)
    : []
  const seenSlots = new Set<string>()
  const duplicateSlots: string[] = []
  for (const entry of entries) {
    const slot = `${entry.type}/${entry.row}`
    if (seenSlots.has(slot)) duplicateSlots.push(slot)
    seenSlots.add(slot)
  }

  const changeEntries = (nextEntries: ManifestEntry[]): void => {
    onChange(setManifest(doc, { entries: nextEntries }), V4_TAGS.manifest)
  }

  const makeExplicit = (): void => {
    changeEntries(autoSlots.map((slot) => ({ type: slot.type, row: slot.row })))
  }

  const moveEntry = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= entries.length) return
    const next = entries.slice()
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    changeEntries(next)
  }

  const addEntry = (): void => {
    const typeId = newTypeId || doc.content.types[0]?.id || ''
    const rows = doc.content.tables[typeId]?.rows ?? []
    const rowId = newRowId && rows.some((row) => row.id === newRowId) ? newRowId : (rows[0]?.id ?? '')
    if (typeId === '' || rowId === '') {
      setError('先建题型与数据行，才能加入显式题单')
      return
    }
    if (entries.length >= SCHEMA_LIMITS_V4.manifestEntries) {
      setError(`显式题单条目已达上限 ${SCHEMA_LIMITS_V4.manifestEntries}（schema 约束）`)
      return
    }
    setError('')
    changeEntries([...entries, { type: typeId, row: rowId }])
  }

  const updateRun = (patch: Partial<RunConfig>): void => {
    onChange(setRunConfig(doc, patch), V4_TAGS.manifest)
  }

  return (
    <div className="v4-manifest-tab" data-testid="v4-manifest-tab">
      {error && (
        <div className="tone-error" data-testid="v4-manifest-error">
          {error}
        </div>
      )}

      {/* run 配置 */}
      <section className="v4-card" data-testid="v4-run-config">
        <div className="v4-card-head">
          <b>运行配置</b>
          <span className="muted">发牌：先题单 → 按 order 洗牌 → 按 count 截断 → 分配 slotIndex</span>
        </div>
        <div className="v4-run-grid">
          <label className="v4-run-field">
            <span>发牌顺序</span>
            <select
              value={run.order}
              data-testid="v4-run-order"
              onChange={(e) => updateRun({ order: e.target.value === 'shuffle' ? 'shuffle' : 'manifest' })}
            >
              <option value="manifest">按题单顺序（manifest）</option>
              <option value="shuffle">洗牌（shuffle）</option>
            </select>
          </label>
          <label className="v4-run-field">
            <span>题数上限</span>
            <input
              type="number"
              min={0}
              placeholder="空 = 全部"
              value={run.count === null ? '' : String(run.count)}
              data-testid="v4-run-count"
              onChange={(e) => {
                const text = e.target.value
                if (text === '') updateRun({ count: null })
                else if (Number.isFinite(Number(text))) updateRun({ count: Math.max(0, Math.trunc(Number(text))) })
              }}
            />
          </label>
          <label className="v4-run-field">
            <span>随机种子</span>
            <input
              placeholder="空 = 每局随机并记录"
              value={run.seed === null ? '' : String(run.seed)}
              data-testid="v4-run-seed"
              onChange={(e) => {
                const text = e.target.value.trim()
                if (text === '') updateRun({ seed: null })
                else if (/^-?\d+$/.test(text)) updateRun({ seed: Number(text) })
                else updateRun({ seed: text })
              }}
            />
          </label>
          <label className="v4-run-field v4-run-check">
            <input
              type="checkbox"
              checked={run.shuffleWithinPhase}
              data-testid="v4-run-shuffle-phase"
              onChange={(e) => updateRun({ shuffleWithinPhase: e.target.checked })}
            />
            <span>阶段内洗牌（阶段顺序不变）</span>
          </label>
        </div>
      </section>

      {/* 自动题单预览 */}
      <section className="v4-card" data-testid="v4-manifest-auto">
        <div className="v4-card-head">
          <b>自动题单预览</b>
          <span className="muted">
            {manifest ? '当前为显式题单（本预览仅参考）' : '当前生效'} · {slotCountLabel(autoSlots)} · 草稿行已排除 ·
            排序：阶段 → 顺序 → 题型声明序 → 行序
          </span>
        </div>
        <ol className="v4-manifest-list">
          {autoSlots.map((slot, index) => (
            <li key={`${slot.type}/${slot.row}/${index}`} data-testid={`v4-auto-slot-${index}`}>
              <span className="v4-slot-index">{index + 1}</span>
              <span className="v4-slot-type">{typeName(doc, slot.type)}</span>
              <span className="v4-slot-row">{rowLabel(doc, slot.type, slot.row)}</span>
              <span className="muted">
                阶段 {slot.phase} · 顺序 {slot.order}
              </span>
            </li>
          ))}
          {autoSlots.length === 0 && <li className="muted">没有可用的题（加行或取消草稿标记）。</li>}
        </ol>
        {!manifest && (
          <div className="v4-card-foot">
            <button type="button" data-testid="v4-manifest-make-explicit" onClick={makeExplicit}>
              改为显式题单（以自动题单为初稿）
            </button>
          </div>
        )}
      </section>

      {/* 显式题单编辑 */}
      {manifest ? (
        <section className="v4-card" data-testid="v4-manifest-explicit">
          <div className="v4-card-head">
            <b>显式题单</b>
            <span className="muted">
              {entries.length}/{SCHEMA_LIMITS_V4.manifestEntries} 项 · 严格按列表顺序执行（draft 不影响执行）
            </span>
            <button type="button" className="v4-card-head-action" data-testid="v4-manifest-clear" onClick={() => onChange(setManifest(doc, null), V4_TAGS.manifest)}>
              恢复自动题单
            </button>
          </div>
          {draftRefs.length > 0 && (
            <div className="tone-error v4-warn" data-testid="v4-manifest-draft-warning">
              ⚠ 显式题单引用了 {draftRefs.length} 个草稿行（第 {draftRefs.map((d) => d.index + 1).join('、')} 项）——
              显式题单会执行草稿行，确认是有意为之。
            </div>
          )}
          {duplicateSlots.length > 0 && (
            <div className="v4-warn" data-testid="v4-manifest-dup-warning">
              ⚠ 同一槽位在题单中重复 {duplicateSlots.length} 次（允许，q.state 共享、组件状态每次重置）。
            </div>
          )}
          <ol className="v4-manifest-list">
            {entries.map((entry, index) => (
              <li key={`${entry.type}/${entry.row}/${index}`} data-testid={`v4-manifest-entry-${index}`}>
                <span className="v4-slot-index">{index + 1}</span>
                <span className="v4-slot-type">{typeName(doc, entry.type)}</span>
                <span className="v4-slot-row">{rowLabel(doc, entry.type, entry.row)}</span>
                <span className="muted">{entry.args === undefined ? '无参数' : `参数 ${JSON.stringify(entry.args)}`}</span>
                <span className="v4-entry-actions">
                  <button
                    type="button"
                    title="编辑 args（ask 调用参数）"
                    data-testid={`v4-manifest-args-${index}`}
                    onClick={() => setArgsEdit({ index, value: entry.args ?? null })}
                  >
                    args
                  </button>
                  <button
                    type="button"
                    title="上移"
                    data-testid={`v4-manifest-up-${index}`}
                    disabled={index === 0}
                    onClick={() => moveEntry(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="下移"
                    data-testid={`v4-manifest-down-${index}`}
                    disabled={index === entries.length - 1}
                    onClick={() => moveEntry(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="ginsp-argdel"
                    title="从题单移除"
                    data-testid={`v4-manifest-remove-${index}`}
                    onClick={() => changeEntries(entries.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
            {entries.length === 0 && <li className="muted">显式题单为空——下面加一条，或「恢复自动题单」。</li>}
          </ol>
          <div className="v4-card-foot">
            <select
              value={newTypeId || doc.content.types[0]?.id || ''}
              data-testid="v4-manifest-new-type"
              onChange={(e) => {
                setNewTypeId(e.target.value)
                setNewRowId('')
              }}
            >
              {doc.content.types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
            <select value={newRowId} data-testid="v4-manifest-new-row" onChange={(e) => setNewRowId(e.target.value)}>
              <option value="">（选择行）</option>
              {(doc.content.tables[newTypeId || doc.content.types[0]?.id || '']?.rows ?? []).map((row, index) => (
                <option key={row.id} value={row.id}>
                  第 {index + 1} 行 · {rowLabel(doc, newTypeId || doc.content.types[0]?.id || '', row.id)}
                </option>
              ))}
            </select>
            <button type="button" data-testid="v4-manifest-add" onClick={addEntry} disabled={doc.content.types.length === 0}>
              + 加入题单
            </button>
          </div>
        </section>
      ) : (
        <section className="v4-card" data-testid="v4-manifest-explicit-empty">
          <div className="v4-card-head">
            <b>显式题单</b>
            <span className="muted">未启用——当前按「自动题单」发牌。需要手排题目/重复题/每题 args 时改为显式。</span>
          </div>
        </section>
      )}

      {/* 牌堆预览 */}
      <section className="v4-card" data-testid="v4-deck-preview">
        <div className="v4-card-head">
          <b>牌堆预览</b>
          <span className="muted">
            {deckBuild.ok
              ? `${deckBuild.value.deck.length} 张 · seed ${deckBuild.value.seed}${deckBuild.value.explicit ? ' · 显式题单' : ' · 自动题单'}`
              : '牌堆生成失败'}
          </span>
          <button
            type="button"
            className="v4-card-head-action"
            data-testid="v4-deck-reshuffle"
            disabled={run.seed !== null}
            title={run.seed !== null ? '固定 seed 下牌堆可复现，改 seed 或清空后再随机' : '用新的预览 seed 模拟本局随机'}
            onClick={() => setPreviewSeed((seed) => seed + 1)}
          >
            换一局预览
          </button>
        </div>
        {deckBuild.ok ? (
          <ol className="v4-manifest-list">
            {deckBuild.value.deck.map((item: DeckItem) => (
              <li key={item.slotIndex} data-testid={`v4-deck-slot-${item.slotIndex}`}>
                <span className="v4-slot-index">{item.slotIndex + 1}</span>
                <span className="v4-slot-type">{typeName(doc, item.type)}</span>
                <span className="v4-slot-row">{rowLabel(doc, item.type, item.row)}</span>
                <span className="muted">
                  阶段 {item.phase} · 顺序 {item.order}
                  {item.args === undefined ? '' : ` · args ${JSON.stringify(item.args)}`}
                </span>
              </li>
            ))}
            {deckBuild.value.deck.length === 0 && <li className="muted">牌堆为空。</li>}
          </ol>
        ) : (
          <div className="tone-error" data-testid="v4-deck-error">
            {deckBuild.error}
          </div>
        )}
      </section>

      {argsEdit && (
        <JsonEditModal
          title={`编辑题单参数 · 第 ${argsEdit.index + 1} 项`}
          value={argsEdit.value}
          hint="ask 调用参数（对象或 null）；会覆盖题目 args 默认值。"
          rows={10}
          testId="v4-manifest-args"
          onApply={(value) => {
            const next = entries.map((entry, index): ManifestEntry => {
              if (index !== argsEdit.index) return entry
              if (value === null) {
                const cleared: ManifestEntry = { type: entry.type, row: entry.row }
                return cleared
              }
              return { type: entry.type, row: entry.row, args: value }
            })
            setArgsEdit(null)
            changeEntries(next)
          }}
          onClose={() => setArgsEdit(null)}
        />
      )}
    </div>
  )
}
