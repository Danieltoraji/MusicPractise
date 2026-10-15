import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getAccountSnapshot, subscribeAccount } from '../account/store'
import { adminApi, type AdminLevel, type AdminUser, type AuditEntry, type AdminStats } from './api'

/**
 * 管理后台（docs/31 §5.4，批次 B4，#/admin）：非 admin 只显示提示（真实安全在 API 403，
 * 页面门禁仅是体验层）；admin 视角 = 统计头 + 用户管理 + 关卡管理 + 审计流。
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

  useEffect(() => {
    void run(async () => {
      await Promise.all([loadStats(), loadUsers(''), loadLevels(''), loadAuditFirstPage()])
    })
  }, [run, loadStats, loadUsers, loadLevels, loadAuditFirstPage])

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
