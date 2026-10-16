/**
 * 群组关卡库面板（docs/39 批次 H5，#/hub 群组 Tab）：登录后可用。
 * 我的群组卡片 + 创建 + 按暗号加入（有密码群需输密码）+ 群组详情
 * （群库上传/审核、成员管理、群主设置/解散）。所有破坏性操作二次确认。
 */
import { useCallback, useEffect, useState } from 'react'
import { bundleFromParsedDocs } from '../library/manage'
import { groupApi, hubApi, type GroupItem, type GroupLookup, type GroupMember, type GroupMeta } from './api'

const ROLE_LABEL: Record<string, string> = { owner: '群主', reviewer: '审核员', member: '成员' }

function fmtKB(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
}

export function GroupPanel({ signedIn }: { signedIn: boolean }) {
  const [groups, setGroups] = useState<GroupMeta[] | null>(null)
  const [selected, setSelected] = useState<{ group: GroupMeta; members: GroupMember[] } | null>(null)
  const [items, setItems] = useState<GroupItem[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const [createFormOpen, setCreateFormOpen] = useState(false)
  const [formName, setFormName] = useState('')
  const [formCode, setFormCode] = useState('')
  const [formPassword, setFormPassword] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [lookup, setLookup] = useState<GroupLookup | null>(null)
  const [joinPassword, setJoinPassword] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sName, setSName] = useState('')
  const [sCode, setSCode] = useState('')
  const [sPw, setSPw] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [sIntro, setSIntro] = useState('')

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setMsg(null)
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }, [])

  const loadMine = useCallback(async (): Promise<void> => {
    const res = await groupApi.mine()
    setGroups(res.groups)
  }, [])

  useEffect(() => {
    if (!signedIn) {
      setGroups(null)
      setSelected(null)
      return
    }
    void run(async () => {
      await loadMine()
    })
  }, [signedIn, run, loadMine])

  if (!signedIn) {
    return <p className="muted">群组功能需要登录——<a href="#/settings">去设置页登录 →</a></p>
  }

  async function handleCreate(): Promise<void> {
    await run(async () => {
      const res = await groupApi.create({ name: formName.trim(), joinCode: formCode.trim(), password: formPassword.trim() === '' ? undefined : formPassword.trim() })
      setCreateFormOpen(false)
      setFormName('')
      setFormCode('')
      setFormPassword('')
      await loadMine()
      setMsg({ ok: true, text: `群组「${res.group.name}」已创建——把加入暗号「${res.group.joinCode}」分享给成员吧` })
    })
  }

  async function handleLookup(): Promise<void> {
    await run(async () => {
      const res = await groupApi.lookup(joinCode.trim())
      setLookup(res.group)
      setJoinPassword('')
    })
  }

  async function handleJoin(): Promise<void> {
    if (lookup === null) return
    await run(async () => {
      await groupApi.join(lookup.id, joinPassword.trim() === '' ? undefined : joinPassword.trim())
      const name = lookup.name
      setLookup(null)
      setJoinCode('')
      await loadMine()
      setMsg({ ok: true, text: `已加入「${name}」` })
    })
  }

  async function refreshDetail(id: string): Promise<void> {
    const detail = await groupApi.detail(id)
    setSelected(detail)
    const list = await groupApi.listItems(id)
    setItems(list.items)
    await loadMine()
  }

  const openDetail = (id: string): void => {
    void run(async () => {
      await refreshDetail(id)
    })
  }

  async function handleUpload(files: FileList | null, mode: 'level' | 'series'): Promise<void> {
    if (!files || files.length === 0 || selected === null) return
    await run(async () => {
      const docs = await Promise.all([...files].map(async (f) => JSON.parse(await f.text()) as Record<string, unknown>))
      if (mode === 'level') {
        const doc = docs[0] as { kind?: string; id?: string; meta?: { title?: string } }
        if (doc.kind !== 'level') throw new Error('请选择关卡 JSON 文档（kind=level）')
        const res = await groupApi.uploadLevel(selected.group.id, String(doc.id), String(doc.meta?.title ?? doc.id), doc)
        setMsg({ ok: true, text: `已提交群库审核（群库现有 ${res.groupLevels} 个关卡，待群主/审核员批准）` })
      } else {
        const bundle = bundleFromParsedDocs(docs)
        const res = await groupApi.uploadSeries(selected.group.id, bundle.folderId, bundle.title, bundle.docs)
        setMsg({ ok: true, text: `系列已提交群库审核（共 ${res.groupLevels} 个关卡）` })
      }
      await refreshDetail(selected.group.id)
    })
  }

  async function handleReview(item: GroupItem, action: 'approve' | 'reject'): Promise<void> {
    if (selected === null) return
    let reason = ''
    if (action === 'reject') {
      const input = window.prompt(`驳回「${item.title}」的理由（将展示给上传者）`)
      if (input === null) return
      if (input.trim() === '') {
        setMsg({ ok: false, text: '驳回理由不能为空' })
        return
      }
      reason = input.trim()
    }
    await run(async () => {
      if (action === 'approve') await groupApi.approveItem(selected.group.id, item.id)
      else await groupApi.rejectItem(selected.group.id, item.id, reason)
      setMsg({ ok: true, text: `已${action === 'approve' ? '批准' : '驳回'}「${item.title}」` })
      await refreshDetail(selected.group.id)
    })
  }

  async function handleRemoveItem(item: GroupItem): Promise<void> {
    if (selected === null) return
    if (!window.confirm(`从群库移除「${item.title}」？`)) return
    await run(async () => {
      await hubApi.withdraw(item.id)
      setMsg({ ok: true, text: `已移除「${item.title}」` })
      await refreshDetail(selected.group.id)
    })
  }

  async function handleSetRole(member: GroupMember, role: 'reviewer' | 'member'): Promise<void> {
    if (selected === null) return
    await run(async () => {
      await groupApi.setMemberRole(selected.group.id, member.userId, role)
      setMsg({ ok: true, text: `已将「${member.nickname}」${role === 'reviewer' ? '设为审核员' : '撤为成员'}` })
      await refreshDetail(selected.group.id)
    })
  }

  async function handleRemoveMember(member: GroupMember): Promise<void> {
    if (selected === null) return
    if (!window.confirm(`将「${member.nickname}」移出群组？其上传的群库条目保留。`)) return
    await run(async () => {
      await groupApi.removeMember(selected.group.id, member.userId)
      setMsg({ ok: true, text: `已移出「${member.nickname}」` })
      await refreshDetail(selected.group.id)
    })
  }

  async function handleSaveSettings(): Promise<void> {
    if (selected === null) return
    await run(async () => {
      await groupApi.update(selected.group.id, {
        name: sName.trim(),
        joinCode: sCode.trim(),
        password: clearPassword ? '' : sPw.trim() === '' ? undefined : sPw.trim(),
        intro: sIntro.trim() === '' ? null : sIntro.trim(),
      })
      setSettingsOpen(false)
      setSPw('')
      setClearPassword(false)
      setMsg({ ok: true, text: clearPassword ? '群设置已保存（密码保护已清除）' : '群设置已保存' })
      await refreshDetail(selected.group.id)
    })
  }

  async function handleDisband(): Promise<void> {
    if (selected === null) return
    if (!window.confirm(`解散群组「${selected.group.name}」？成员与群库条目将一并清除，不可恢复。`)) return
    await run(async () => {
      await groupApi.disband(selected.group.id)
      setSelected(null)
      setSettingsOpen(false)
      await loadMine()
      setMsg({ ok: true, text: '群组已解散' })
    })
  }

  async function handleLeave(): Promise<void> {
    if (selected === null) return
    if (!window.confirm(`退出群组「${selected.group.name}」？`)) return
    await run(async () => {
      await groupApi.leave(selected.group.id)
      setSelected(null)
      await loadMine()
      setMsg({ ok: true, text: '已退出群组' })
    })
  }

  const isOwner = selected !== null && selected.group.myRole === 'owner'
  const canReview = selected !== null && (selected.group.myRole === 'owner' || selected.group.myRole === 'reviewer')

  if (selected !== null) {
    const g = selected.group
    return (
      <div>
        <div className="admin-toolbar">
          <button type="button" className="link" onClick={() => setSelected(null)}>
            ← 我的群组
          </button>
          <b>
            {g.name}
            {g.status === 'banned' && <span className="lib-badge"> 已封禁</span>}
          </b>
          <span className="muted">
            暗号：{g.joinCode} · {ROLE_LABEL[g.myRole ?? 'member']}
          </span>
          {isOwner && (
            <button
              type="button"
              className="link"
              onClick={() => {
                setSName(g.name)
                setSCode(g.joinCode)
                setSPw('')
                setClearPassword(false)
                setSIntro(g.intro ?? '')
                setSettingsOpen((v) => !v)
              }}
            >
              群设置
            </button>
          )}
          {isOwner ? (
            <button type="button" className="link danger" disabled={busy} onClick={() => void handleDisband()}>
              解散群组
            </button>
          ) : (
            <button type="button" className="link danger" disabled={busy} onClick={() => void handleLeave()}>
              退群
            </button>
          )}
        </div>
        {msg && <p className={msg.ok ? 'muted' : 'tone-error'}>{msg.text}</p>}

        {settingsOpen && isOwner && (
          <div className="ai-new-form">
            <input value={sName} placeholder="群名称" onChange={(e) => setSName(e.target.value)} />
            <input value={sCode} placeholder="加入暗号" onChange={(e) => setSCode(e.target.value)} />
            <input value={sPw} placeholder="加入密码（留空 = 不修改）" onChange={(e) => setSPw(e.target.value)} />
            <label className="muted">
              <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} /> 清除密码保护（凭暗号即可加入）
            </label>
            <input value={sIntro} placeholder="群简介（可选）" onChange={(e) => setSIntro(e.target.value)} />
            <button type="button" className="primary" disabled={busy} onClick={() => void handleSaveSettings()}>
              保存设置
            </button>
            <span className="muted">密码留空表示不修改；要清除密码保护请先保存后再清空一次（提交空格）。</span>
          </div>
        )}

        <div className="lib-divider">📤 上传到群库</div>
        <div className="admin-toolbar">
          <label className="link">
            上传关卡（.json）
            <input type="file" accept=".json" hidden onChange={(e) => { void handleUpload(e.target.files, 'level'); e.target.value = '' }} />
          </label>
          <label className="link">
            上传系列（多个 .json）
            <input type="file" accept=".json" multiple hidden onChange={(e) => { void handleUpload(e.target.files, 'series'); e.target.value = '' }} />
          </label>
          <span className="muted">上传后经群主/审核员批准在群内展示；单条目 ≤20 关。</span>
        </div>

        <div className="lib-divider">📚 群库</div>
        <div className="admin-table">
          {items.length === 0 ? (
            <p className="muted">群库还是空的——上传关卡或系列吧。</p>
          ) : (
            items.map((item) => (
              <div key={item.id} className="admin-row">
                <b>
                  {item.itemKind === 'series' ? '📚' : '🎯'} {item.title}
                </b>
                <span className="muted">上传者：{item.submitterName}</span>
                <span className="muted">
                  {item.itemKind === 'series' ? `${item.levelCount} 个关卡` : '单关'} · {fmtKB(item.bytes)}
                </span>
                {item.status === 'pending' && <span className="lib-badge">⏳ 待审核</span>}
                {item.status === 'published' && <span className="lib-badge">✅ 已展示</span>}
                {item.status === 'rejected' && <span className="lib-badge" title={item.rejectReason ?? ''}>❌ 未通过</span>}
                <span className="row-actions">
                  {item.status === 'pending' && canReview && (
                    <>
                      <button type="button" className="link" disabled={busy} onClick={() => void handleReview(item, 'approve')}>
                        批准
                      </button>
                      <button type="button" className="link danger" disabled={busy} onClick={() => void handleReview(item, 'reject')}>
                        驳回
                      </button>
                    </>
                  )}
                  <button type="button" className="link danger" disabled={busy} onClick={() => void handleRemoveItem(item)}>
                    移除
                  </button>
                </span>
              </div>
            ))
          )}
        </div>

        <div className="lib-divider">👥 成员（{selected.members.length}）</div>
        <div className="admin-table">
          {selected.members.map((m) => (
            <div key={m.userId} className="admin-row">
              <b>{m.nickname}</b>
              <span className="account-badge">{ROLE_LABEL[m.role]}</span>
              <span className="muted id-hint">{m.userId}</span>
              <span className="row-actions">
                {isOwner && m.role === 'member' && (
                  <button type="button" className="link" disabled={busy} onClick={() => void handleSetRole(m, 'reviewer')}>
                    设为审核员
                  </button>
                )}
                {isOwner && m.role === 'reviewer' && (
                  <button type="button" className="link" disabled={busy} onClick={() => void handleSetRole(m, 'member')}>
                    撤为成员
                  </button>
                )}
                {isOwner && m.role !== 'owner' && (
                  <button type="button" className="link danger" disabled={busy} onClick={() => void handleRemoveMember(m)}>
                    移出
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      {msg && <p className={msg.ok ? 'muted' : 'tone-error'}>{msg.text}</p>}
      <div className="admin-toolbar">
        <button type="button" className="primary" onClick={() => setCreateFormOpen((v) => !v)}>
          创建群组
        </button>
        <input value={joinCode} placeholder="输入加入暗号…" onChange={(e) => setJoinCode(e.target.value)} />
        <button type="button" disabled={busy || joinCode.trim() === ''} onClick={() => void handleLookup()}>
          查找群组
        </button>
      </div>

      {createFormOpen && (
        <div className="ai-new-form">
          <input value={formName} placeholder="群名称（1–32 字）" onChange={(e) => setFormName(e.target.value)} />
          <input value={formCode} placeholder="加入暗号（4–24 字符，不含空白，全局唯一）" onChange={(e) => setFormCode(e.target.value)} />
          <input value={formPassword} placeholder="加入密码（可选，4–128 位）" onChange={(e) => setFormPassword(e.target.value)} />
          <button type="button" className="primary" disabled={busy} onClick={() => void handleCreate()}>
            创建
          </button>
          <span className="muted">每人最多创建 3 个群组；暗号用于检索，密码是第二道口令。</span>
        </div>
      )}

      {lookup !== null && (
        <div className="ai-new-form">
          <b>
            找到群组「{lookup.name}」
          </b>
          <span className="muted">
            {lookup.intro ?? '（无简介）'} · {lookup.memberCount} 名成员
          </span>
          {lookup.hasPassword && <input value={joinPassword} placeholder="加入密码" onChange={(e) => setJoinPassword(e.target.value)} />}
          <button type="button" className="primary" disabled={busy} onClick={() => void handleJoin()}>
            {lookup.hasPassword ? '输入密码并加入' : '加入'}
          </button>
          <button type="button" className="link" onClick={() => setLookup(null)}>
            取消
          </button>
        </div>
      )}

      {groups === null ? (
        <p className="muted">加载中…</p>
      ) : groups.length === 0 ? (
        <p className="muted">还没有加入任何群组——创建一个，或用暗号查找。</p>
      ) : (
        <div className="admin-table">
          {groups.map((g) => (
            <div key={g.id} className="admin-row">
              <b>{g.name}</b>
              {g.status === 'banned' && <span className="lib-badge">已封禁</span>}
              <span className="account-badge">{ROLE_LABEL[g.myRole ?? 'member']}</span>
              <span className="muted">{g.memberCount} 名成员 · 暗号：{g.joinCode}</span>
              <span className="row-actions">
                <button type="button" className="link" disabled={busy} onClick={() => openDetail(g.id)}>
                  进入
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
