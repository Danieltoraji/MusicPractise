import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getAccountSnapshot, subscribeAccount } from '../account/store'
import { adminApi, type AdminHubItem, type AdminLevel, type AdminUser, type AuditEntry, type AdminStats } from './api'
import { hubApi } from '../hub/api'
import { importDocuments, type ImportReport } from '../library/io'

/**
 * 管理后台（docs/31 §5.4，批次 B4；docs/39 H4 扩展关卡库审核与官方库）：
 * 非 admin 只显示提示（真实安全在 API 403，页面门禁仅是体验层）；
 * admin 视角 = 统计头 + 用户管理 + 关卡管理 + 关卡库审核 + 官方库管理 + 审计流。
 * 破坏性操作全部 window.confirm/prompt 二次确认（与资源库删除同款惯例）。
 */
export function AdminPage() {
  const snap = useSyncExternalStore(subscribeAccount, getAccountSnapshot)

  if (snap.phase === 'probing') return <PageHint text="云端状态检测中…" />
  if (snap.phase === 'unavailable') return <PageHint text="云端不可用（离线或服务未部署）。" />
  if (!snap.user) {
    return (
      <PageHint text="管理后台需要登录。">
        <a href="#/settings">去设置页登录 →</a>
      </PageHint>
    )
  }
  if (snap.user.role !== 'admin') return <PageHint text="该页面仅管理员可见。" />
  return <AdminDashboard />
}

function PageHint(props: { text: string; children?: React.ReactNode }): React.ReactNode {
  return (
    <div className="page">
      <h1>管理后台</h1>
      <p className="muted admin-hint">
        {props.text}
        {props.children}
      </p>
    </div>
  )
}

function fmtKB(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
}

function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [usersTotal, setUsersTotal] = useState(0)
  const [userQuery, setUserQuery] = useState('')
  const [levels, setLevels] = useState<AdminLevel[]>([])
  const [levelsTotal, setLevelsTotal] = useState(0)
  const [levelQuery, setLevelQuery] = useState('')
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [auditTotal, setAuditTotal] = useState(0)
  const [auditOffset, setAuditOffset] = useState(0)
  // docs/39 H4：关卡库审核 + 官方库
  const [hubStatus, setHubStatus] = useState<'pending' | 'published'>('pending')
  const [hubItems, setHubItems] = useState<AdminHubItem[]>([])
  const [hubTotal, setHubTotal] = useState(0)
  const [hubQuery, setHubQuery] = useState('')
  const [officialItems, setOfficialItems] = useState<AdminHubItem[]>([])
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const loadStats = useCallback(async (): Promise<void> => setStats(await adminApi.stats()), [])
  const loadUsers = useCallback(async (query: string): Promise<void> => {
    const res = await adminApi.listUsers(query)
    setUsers(res.users)
    setUsersTotal(res.total)
  }, [])
  const loadLevels = useCallback(async (query: string): Promise<void> => {
    const res = await adminApi.listLevels(query)
    setLevels(res.levels)
    setLevelsTotal(res.total)
  }, [])
  const loadAuditFirstPage = useCallback(async (): Promise<void> => {
    const res = await adminApi.listAudit(0)
    setAudit(res.entries)
    setAuditTotal(res.total)
    setAuditOffset(res.entries.length)
  }, [])
  const loadHub = useCallback(async (status: 'pending' | 'published', query: string): Promise<void> => {
    const res = await adminApi.listHub(status, query)
    setHubItems(res.items)
    setHubTotal(res.total)
  }, [])
  const loadOfficial = useCallback(async (): Promise<void> => {
    const first = await adminApi.listHub('published', '', 0, 100)
    const all = first.total > first.items.length ? [...first.items, ...(await adminApi.listHub('published', '', first.items.length, 100)).items] : first.items
    setOfficialItems(all.filter((i) => i.scope === 'official'))
  }, [])

  useEffect(() => {
    void run(async () => {
      await Promise.all([loadStats(), loadUsers(''), loadLevels(''), loadAuditFirstPage(), loadHub('pending', ''), loadOfficial()])
    })
  }, [run, loadStats, loadUsers, loadLevels, loadAuditFirstPage, loadHub, loadOfficial])

  const patchUser = (user: AdminUser, patch: Parameters<typeof adminApi.patchUser>[1], okText: string): void => {
    void run(async () => {
      await adminApi.patchUser(user.id, patch)
      setNotice(`${okText}（${user.nickname}）`)
      await Promise.all([loadUsers(userQuery), loadStats()])
      await loadAuditFirstPage()
    })
  }

  const removeUser = (user: AdminUser): void => {
    if (!window.confirm(`删除用户「${user.nickname}」？其云盘关卡、通关记录、登录态将一并清除，不可恢复。`)) return
    void run(async () => {
      await adminApi.deleteUser(user.id)
      setNotice(`已删除用户「${user.nickname}」`)
      await Promise.all([loadUsers(userQuery), loadLevels(levelQuery), loadStats(), loadAuditFirstPage()])
    })
  }

  const resetPassword = (user: AdminUser): void => {
    const newPassword = window.prompt(`为「${user.nickname}」设置新密码（至少 8 位）。重置后该用户所有登录会立即失效。`)
    if (newPassword === null) return
    if (newPassword.length < 8) {
      setError('新密码至少 8 位')
      return
    }
    patchUser(user, { newPassword }, '已重置密码')
  }

  const removeLevel = (level: AdminLevel): void => {
    if (!window.confirm(`删除云端关卡「${level.title}」（属主：${level.ownerNickname}）？不可恢复。`)) return
    void run(async () => {
      await adminApi.deleteLevel(level.id)
      setNotice(`已删除关卡「${level.title}」`)
      await Promise.all([loadLevels(levelQuery), loadStats()])
      await loadAuditFirstPage()
    })
  }

  const loadMoreAudit = (): void => {
    void run(async () => {
      const res = await adminApi.listAudit(auditOffset)
      setAudit((prev) => [...prev, ...res.entries])
      setAuditTotal(res.total)
      setAuditOffset((prev) => prev + res.entries.length)
    })
  }

  // docs/39 H4：关卡库审核与官方库管理
  const reloadHub = useCallback(async (): Promise<void> => {
    await loadHub(hubStatus, hubQuery)
    await loadOfficial()
    await loadAuditFirstPage()
  }, [loadHub, loadOfficial, hubStatus, hubQuery, loadAuditFirstPage])

  const approveHub = (item: AdminHubItem, featured: boolean): void => {
    void run(async () => {
      await adminApi.approveHub(item.id, featured)
      setNotice(`已批准「${item.title}」${featured ? '并设为精选' : ''}`)
      await reloadHub()
    })
  }

  const rejectHub = (item: AdminHubItem): void => {
    const reason = window.prompt(`驳回「${item.title}」：请输入理由（将展示给申请人）`)
    if (reason === null) return
    if (reason.trim() === '') {
      setError('驳回理由不能为空')
      return
    }
    void run(async () => {
      await adminApi.rejectHub(item.id, reason.trim())
      setNotice(`已驳回「${item.title}」`)
      await reloadHub()
    })
  }

  const toggleHubFeatured = (item: AdminHubItem): void => {
    void run(async () => {
      await adminApi.setHubFeatured(item.id, !item.featured)
      setNotice(`已${item.featured ? '取消' : '设置'}精选（${item.title}）`)
      await reloadHub()
    })
  }

  const removeHub = (item: AdminHubItem): void => {
    if (!window.confirm(`从关卡库移除「${item.title}」（${item.scope === 'official' ? '官方' : '公共'} · ${item.status === 'published' ? '已发布' : item.status}）？申请人可在云盘重新申请。`)) return
    void run(async () => {
      await adminApi.deleteHub(item.id)
      setNotice(`已移除「${item.title}」`)
      await reloadHub()
    })
  }

  // 导入试玩：拉取条目快照写入本机资源库（admin 对 pending/published 均可取详情）
  const previewHub = (item: AdminHubItem): void => {
    void run(async () => {
      const res = await hubApi.get(item.id)
      setReport(await importDocuments(res.docs.map((d) => ({ file: `${d.id}.json`, raw: d.payload }))))
    })
  }

  const handleOfficialUpload = (files: FileList | null, mode: 'level' | 'series'): void => {
    if (!files || files.length === 0) return
    void run(async () => {
      const docs = await Promise.all([...files].map(async (f) => JSON.parse(await f.text()) as Record<string, unknown>))
      if (mode === 'level') {
        const doc = docs[0] as { kind?: string; id?: string; meta?: { title?: string } }
        if (doc.kind !== 'level') throw new Error('请选择关卡 JSON 文档（kind=level）')
        await adminApi.createOfficialLevel(String(doc.id), String(doc.meta?.title ?? doc.id), doc)
      } else {
        const series = docs.find((d) => d.kind === 'series') as { id: string; meta?: { title?: string }; content?: { topicIds?: string[] } } | undefined
        if (!series) throw new Error('所选文件中没有系列文档（kind=series）')
        const byId = new Map(docs.filter((d) => typeof d.id === 'string').map((d) => [String(d.id), d]))
        const bundle: { id: string; kind: string; payload: unknown }[] = [{ id: series.id, kind: 'series', payload: series }]
        const seen = new Set<string>([series.id])
        for (const tid of series.content?.topicIds ?? []) {
          const t = byId.get(tid) as { content?: { levelIds?: string[] } } | undefined
          if (!t) throw new Error(`缺件：专题 ${tid} 不在所选文件中`)
          if (!seen.has(tid)) {
            seen.add(tid)
            bundle.push({ id: tid, kind: 'topic', payload: t })
          }
          for (const lid of t.content?.levelIds ?? []) {
            const l = byId.get(lid)
            if (!l) throw new Error(`缺件：关卡 ${lid} 不在所选文件中`)
            if (!seen.has(lid)) {
              seen.add(lid)
              bundle.push({ id: lid, kind: 'level', payload: l })
            }
          }
        }
        await adminApi.createOfficialSeries(series.id, String(series.meta?.title ?? series.id), bundle)
      }
      setNotice('官方条目已上传并发布')
      await reloadHub()
    })
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>管理后台</h1>
          <p className="page-sub">用户、云盘关卡与审计的集中管理面；破坏性操作均有二次确认，真实门禁在服务端。</p>
        </div>
        {stats && (
          <div className="admin-stats">
            <span className="stat-chip">
              <b>{stats.users}</b> 用户
            </span>
            <span className="stat-chip">
              <b>{stats.cloudLevels}</b> 云盘关卡
            </span>
            <span className="stat-chip">
              <b>{stats.activeSessions}</b> 活跃会话
            </span>
          </div>
        )}
      </header>
      {error && <p className="tone-error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}
      {report && (
        <div className="import-report">
          <b>导入完成</b>：新增 {report.added.length} · 更新 {report.updated.length} · 跳过 {report.skipped.length} · 拒绝 {report.rejected.length}
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

      <h2>用户管理</h2>
      <div className="admin-toolbar">
        <input
          value={userQuery}
          placeholder="🔍 按昵称搜索…"
          onChange={(e) => setUserQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(() => loadUsers(userQuery))
          }}
        />
        <button type="button" className="link" disabled={busy} onClick={() => void run(() => loadUsers(userQuery))}>
          搜索
        </button>
        <span className="muted">共 {usersTotal} 人</span>
      </div>
      <div className="admin-table">
        {users.length === 0 ? (
          <p className="muted">没有匹配的用户。</p>
        ) : (
          users.map((u) => (
            <div key={u.id} className="admin-row">
              <b>{u.nickname}</b>
              {u.role === 'admin' && <span className="account-badge">管理员</span>}
              <span className={`admin-status ${u.status === 'active' ? 'is-ok' : 'is-bad'}`}>{u.status === 'active' ? '正常' : '已禁用'}</span>
              <span className="muted id-hint">{u.id}</span>
              <span className="row-actions">
                <select
                  value={u.role}
                  disabled={busy}
                  onChange={(e) => {
                    const role = e.target.value as 'user' | 'admin'
                    if (role === u.role) return
                    if (window.confirm(`将「${u.nickname}」的角色改为 ${role === 'admin' ? '管理员' : '普通用户'}？`)) {
                      patchUser(u, { role }, '已调整角色')
                    } else {
                      e.target.value = u.role
                    }
                  }}
                >
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
                {u.status === 'active' ? (
                  <button type="button" className="link danger" disabled={busy} onClick={() => patchUser(u, { status: 'disabled' }, '已禁用并强制下线')}>
                    禁用
                  </button>
                ) : (
                  <button type="button" className="link" disabled={busy} onClick={() => patchUser(u, { status: 'active' }, '已启用')}>
                    启用
                  </button>
                )}
                <button type="button" className="link" disabled={busy} onClick={() => resetPassword(u)}>
                  重置密码
                </button>
                <button type="button" className="link danger" disabled={busy} onClick={() => removeUser(u)}>
                  删除
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      <h2>云盘关卡</h2>
      <div className="admin-toolbar">
        <input
          value={levelQuery}
          placeholder="🔍 按标题搜索…"
          onChange={(e) => setLevelQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(() => loadLevels(levelQuery))
          }}
        />
        <button type="button" className="link" disabled={busy} onClick={() => void run(() => loadLevels(levelQuery))}>
          搜索
        </button>
        <span className="muted">共 {levelsTotal} 个</span>
      </div>
      <div className="admin-table">
        {levels.length === 0 ? (
          <p className="muted">没有匹配的云盘关卡。</p>
        ) : (
          levels.map((l) => (
            <div key={l.id} className="admin-row">
              <b>{l.title || l.levelId}</b>
              <span className="muted">属主：{l.ownerNickname}</span>
              <span className="muted">{fmtKB(l.bytes)} · {new Date(l.updatedAt).toLocaleString()}</span>
              <span className="row-actions">
                <button type="button" className="link danger" disabled={busy} onClick={() => removeLevel(l)}>
                  删除
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      <h2>关卡库审核</h2>
      <div className="admin-toolbar">
        <select
          value={hubStatus}
          onChange={(e) => {
            const status = e.target.value as 'pending' | 'published'
            setHubStatus(status)
            void run(() => loadHub(status, hubQuery))
          }}
        >
          <option value="pending">待审核</option>
          <option value="published">已发布</option>
        </select>
        <input
          value={hubQuery}
          placeholder="🔍 按标题搜索…"
          onChange={(e) => setHubQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(() => loadHub(hubStatus, hubQuery))
          }}
        />
        <button type="button" className="link" disabled={busy} onClick={() => void run(() => loadHub(hubStatus, hubQuery))}>
          搜索
        </button>
        <span className="muted">共 {hubTotal} 条</span>
      </div>
      <div className="admin-table">
        {hubItems.length === 0 ? (
          <p className="muted">{hubStatus === 'pending' ? '没有待审核的申请。' : '没有已发布的条目。'}</p>
        ) : (
          hubItems.map((item) => (
            <div key={item.id} className="admin-row">
              <b>
                {item.itemKind === 'series' ? '📚' : '🎯'} {item.title}
              </b>
              <span className="muted">{item.scope === 'official' ? '官方' : `申请人：${item.submitterName}`}</span>
              <span className="muted">
                {item.itemKind === 'series' ? `${item.levelCount} 个关卡` : '单关'} · {fmtKB(item.bytes)}
              </span>
              {item.status === 'pending' && item.submitterNote !== null && (
                <span className="muted" title={item.submitterNote}>
                  留言：{item.submitterNote.slice(0, 20)}
                  {item.submitterNote.length > 20 ? '…' : ''}
                </span>
              )}
              {item.wantFeatured && <span className="account-badge">申请精选</span>}
              {item.featured && <span className="account-badge">精选</span>}
              {item.scope === 'official' && <span className="account-badge">官方</span>}
              <span className="row-actions">
                <button type="button" className="link" disabled={busy} onClick={() => previewHub(item)}>
                  导入试玩
                </button>
                {item.status === 'pending' && item.scope === 'public' && (
                  <>
                    <button type="button" className="link" disabled={busy} onClick={() => approveHub(item, false)}>
                      批准
                    </button>
                    <button type="button" className="link" disabled={busy} onClick={() => approveHub(item, true)}>
                      批准并精选
                    </button>
                    <button type="button" className="link danger" disabled={busy} onClick={() => rejectHub(item)}>
                      驳回
                    </button>
                  </>
                )}
                {item.status === 'published' && item.scope === 'public' && (
                  <button type="button" className="link" disabled={busy} onClick={() => toggleHubFeatured(item)}>
                    {item.featured ? '取消精选' : '设为精选'}
                  </button>
                )}
                <button type="button" className="link danger" disabled={busy} onClick={() => removeHub(item)}>
                  移除
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      <h2>官方库管理</h2>
      <p className="muted">官方条目直接发布到「关卡库 → 官方关卡」Tab；上传同 id 内容将覆盖更新；上限 200 条。系列需连同其专题与关卡 JSON 一起选择。</p>
      <div className="admin-toolbar">
        <label className="link">
          上传官方关卡（.json）
          <input
            type="file"
            accept=".json"
            hidden
            onChange={(e) => {
              handleOfficialUpload(e.target.files, 'level')
              e.target.value = ''
            }}
          />
        </label>
        <label className="link">
          上传官方系列（多个 .json）
          <input
            type="file"
            accept=".json"
            multiple
            hidden
            onChange={(e) => {
              handleOfficialUpload(e.target.files, 'series')
              e.target.value = ''
            }}
          />
        </label>
      </div>
      <div className="admin-table">
        {officialItems.length === 0 ? (
          <p className="muted">官方库还没有条目。</p>
        ) : (
          officialItems.map((item) => (
            <div key={item.id} className="admin-row">
              <b>
                {item.itemKind === 'series' ? '📚' : '🎯'} {item.title}
              </b>
              <span className="muted">
                {item.itemKind === 'series' ? `${item.levelCount} 个关卡` : '单关'} · {fmtKB(item.bytes)} · 下载 {item.downloads ?? '—'}
              </span>
              <span className="row-actions">
                <button type="button" className="link" disabled={busy} onClick={() => previewHub(item)}>
                  导入试玩
                </button>
                <button type="button" className="link danger" disabled={busy} onClick={() => removeHub(item)}>
                  移除
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      <h2>审计日志</h2>
      <div className="admin-table">
        {audit.length === 0 ? (
          <p className="muted">暂无管理操作记录。</p>
        ) : (
          audit.map((entry) => (
            <div key={entry.id} className="admin-row admin-audit-row">
              <span className="muted">{new Date(entry.createdAt).toLocaleString()}</span>
              <b>{entry.actorNickname ?? '（已注销）'}</b>
              <span>{entry.action}</span>
              <span className="muted">
                {entry.targetType}:{entry.targetId}
                {entry.detail ? ` · ${JSON.stringify(entry.detail)}` : ''}
              </span>
            </div>
          ))
        )}
        {audit.length < auditTotal && (
          <button type="button" className="link" disabled={busy} onClick={loadMoreAudit}>
            加载更多（{audit.length}/{auditTotal}）
          </button>
        )}
      </div>
    </div>
  )
}
