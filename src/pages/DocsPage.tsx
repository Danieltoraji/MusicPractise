/**
 * 文档页（#/docs 与 #/docs/:id，docs/35 §4）：
 * 左侧分组目录（带搜索）+ 正文 + 底部上一篇/下一篇翻页器，版式参考 api-docs.deepseek.com。
 * 纯展示层：路由由 App 传入子路径，链接全部走 hash，无任何数据写入。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { DOC_FLAT, DOC_GROUPS, findDoc, type DocItem } from './docsContent'

const DEFAULT_ID = 'about'

export function DocsPage({ subId }: { subId: string }) {
  const current = findDoc(subId) ?? findDoc(DEFAULT_ID)!
  const [query, setQuery] = useState('')
  const articleRef = useRef<HTMLDivElement>(null)

  // 切换文档回到顶部（App 不带 key 复用本组件，需自行滚动）
  useEffect(() => {
    articleRef.current?.scrollIntoView?.(window.scrollY > 0 ? { block: 'start' } : undefined)
    window.scrollTo(0, 0)
  }, [current.id])

  const q = query.trim().toLowerCase()
  const filteredGroups = useMemo(
    () =>
      DOC_GROUPS.map((g) => ({
        ...g,
        items: q
          ? g.items.filter(
              (it) => it.title.toLowerCase().includes(q) || it.id.includes(q) || (it.keywords ?? '').toLowerCase().includes(q),
            )
          : g.items,
      })).filter((g) => g.items.length > 0),
    [q],
  )

  const idx = DOC_FLAT.findIndex((d) => d.id === current.id)
  const prev: DocItem | undefined = idx > 0 ? DOC_FLAT[idx - 1] : undefined
  const next: DocItem | undefined = idx >= 0 && idx < DOC_FLAT.length - 1 ? DOC_FLAT[idx + 1] : undefined

  return (
    <div className="page docs">
      <aside className="docs-side">
        <input
          className="docs-search"
          type="search"
          placeholder="搜索文档…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索文档"
        />
        <nav className="docs-nav" aria-label="文档目录">
          {filteredGroups.length === 0 && <p className="muted docs-nav-empty">没有匹配的文档</p>}
          {filteredGroups.map((g) => (
            <div key={g.title} className="docs-group">
              <div className="docs-group-title">{g.title}</div>
              {g.items.map((it) => (
                <a key={it.id} href={`#/docs/${it.id}`} className={`docs-link${it.id === current.id ? ' active' : ''}`}>
                  {it.title}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <article className="docs-article" ref={articleRef}>
        <h1>{current.title}</h1>
        {current.body}
        <div className="docs-pager">
          {prev ? (
            <a className="docs-pager-link" href={`#/docs/${prev.id}`}>
              <span className="docs-pager-dir">← 上一篇</span>
              <span className="docs-pager-title">{prev.title}</span>
            </a>
          ) : (
            <span />
          )}
          {next ? (
            <a className="docs-pager-link docs-pager-next" href={`#/docs/${next.id}`}>
              <span className="docs-pager-dir">下一篇 →</span>
              <span className="docs-pager-title">{next.title}</span>
            </a>
          ) : (
            <span />
          )}
        </div>
      </article>
    </div>
  )
}
