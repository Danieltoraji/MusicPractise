/**
 * 关卡库（docs/39 批次 H3，#/hub）：全站共享关卡的浏览与下载入口。
 * 公共/精选两 Tab 走公共域（精选 = featured 过滤）；官方/群组两 Tab H4/H5 落地。
 * 下载 = 取条目快照 → importDocuments 既有管线（信封校验→闭包→冲突策略→事务）。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getAccountSnapshot, subscribeAccount } from '../account/store'
import { importDocuments, type ImportReport } from '../library/io'
import { hubApi, type HubItemMeta } from './api'
import { GroupPanel } from './GroupPanel'

type HubTab = 'public' | 'featured' | 'official' | 'group'

const TABS: { key: HubTab; label: string }[] = [
  { key: 'public', label: '公共关卡' },
  { key: 'featured', label: '精选' },
  { key: 'official', label: '官方关卡' },
  { key: 'group', label: '群组关卡' },
]

const PAGE_SIZE = 20

function fmtKB(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
}

export function HubPage() {
  const account = useSyncExternalStore(subscribeAccount, getAccountSnapshot)
  const signedIn = account.phase === 'available' && account.user !== null
  const [tab, setTab] = useState<HubTab>('public')
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<HubItemMeta[] | null>(null)
  const [total, setTotal] = useState(0)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (which: HubTab, q: string, offset: number): Promise<void> => {
      if (which !== 'public' && which !== 'featured' && which !== 'official') return
      setLoading(true)
      try {
        const res = await hubApi.list({
          scope: which === 'official' ? 'official' : 'public',
          featured: which === 'featured' ? true : undefined,
          query: q,
          limit: PAGE_SIZE,
          offset,
        })
        setItems((prev) => (offset === 0 || prev === null ? res.items : [...prev, ...res.items]))
        setTotal(res.total)
      } catch (err) {
        setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
        if (offset === 0) setItems([])
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    setMsg(null)
    setReport(null)
    if (tab === 'public' || tab === 'featured' || tab === 'official') void load(tab, query, 0)
  }, [tab, query, load])

  async function handleDownload(item: HubItemMeta): Promise<void> {
    setMsg(null)
    setReport(null)
    setBusyId(item.id)
    try {
      const res = await hubApi.get(item.id)
      setReport(await importDocuments(res.docs.map((d) => ({ file: `${d.id}.json`, raw: d.payload }))))
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusyId(null)
    }
  }

  const visible = tab === 'public' || tab === 'featured' || tab === 'official'
  const hasMore = items !== null && items.length < total

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>关卡库</h1>
          <p className="page-sub">浏览并下载社区共享的关卡与系列——下载会导入本机资源库，可直接游玩或改编。</p>
        </div>
        {visible && (
          <div className="page-actions">
            <input
              className="library-search"
              value={queryInput}
              placeholder="🔍 按标题搜索…"
              onChange={(e) => setQueryInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setQuery(queryInput.trim())
              }}
            />
            <button type="button" onClick={() => setQuery(queryInput.trim())}>
              搜索
            </button>
          </div>
        )}
      </header>

      <div className="hub-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={tab === t.key ? 'primary' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {msg && <p className={msg.ok ? 'muted' : 'tone-error'}>{msg.text}</p>}
      {report && (
        <div className="import-report">
          <b>下载完成</b>：新增 {report.added.length} · 更新 {report.updated.length} · 跳过 {report.skipped.length} · 拒绝 {report.rejected.length}
          {report.aborted && '（因缺件整包未写入）'}
          <ul>
            {report.missing.map((m) => (
              <li key={m.id} className="tone-error">
                缺件：{m.id}（被 {m.neededBy} 引用）
              </li>
            ))}
            {report.rejected.map((r) => (
              <li key={r.file} className="tone-error">
                {r.file}：{r.reasons.join('；')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!visible ? (
        <GroupPanel signedIn={signedIn} />
      ) : items === null ? (
        <p className="muted">加载中…</p>
      ) : items.length === 0 ? (
        <p className="muted">
          {query !== ''
            ? `没有匹配「${query}」的条目。`
            : tab === 'official'
              ? '官方关卡库还没有内容。'
              : tab === 'featured'
                ? '精选关卡暂空——管理员会从公共关卡中挑选佳作。'
                : '关卡库还是空的——到'}
          {query === '' && tab === 'public' && <a href="#/cloud">我的云盘</a>}
          {query === '' && tab === 'public' && '把你的关卡申请公开吧。'}
        </p>
      ) : (
        <>
          <ul className="cloud-list">
            {items.map((item) => (
              <li key={item.id} className="cloud-row">
                <span className="cloud-title" title={item.rootDocId}>
                  {item.itemKind === 'series' ? '📚' : '🎯'} {item.title}
                  {item.featured && <span className="lib-badge"> 精选</span>}
                </span>
                <span className="muted">
                  {item.authorName} · {item.itemKind === 'series' ? `${item.levelCount} 个关卡` : '单关'} · {fmtKB(item.bytes)} · 下载 {item.downloads}
                </span>
                <span className="row-actions">
                  <button type="button" className="link" disabled={busyId !== null} onClick={() => void handleDownload(item)}>
                    {busyId === item.id ? '下载中…' : '下载到本机'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">
            已显示 {items.length} / {total}
            {hasMore && (
              <button type="button" className="link" disabled={loading} onClick={() => void load(tab, query, items.length)}>
                {loading ? '加载中…' : '加载更多'}
              </button>
            )}
          </p>
        </>
      )}
    </div>
  )
}
