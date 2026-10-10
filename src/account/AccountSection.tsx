import { useState, useSyncExternalStore } from 'react'
import { ApiError, ApiUnavailableError } from '../api/client'
import {
  changePassword,
  getAccountSnapshot,
  login,
  logout,
  register,
  subscribeAccount,
  updateNickname,
} from './store'

/**
 * 设置页「账户」区（docs/31 §7）：按账户 store 三态渲染——
 * probing 检测中 / unavailable 云端不可用（明确告知本地功能不受影响）/
 * available 未登录（登录|注册切换表单）或已登录（改昵称 + 改密码 + 退出）。
 * 反馈复用 .settings-test-ok/.settings-test-bad 惯例；本组件不做任何本地数据写入。
 */
export function AccountSection() {
  const snap = useSyncExternalStore(subscribeAccount, getAccountSnapshot)

  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [newNickname, setNewNickname] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)

  if (snap.phase === 'probing') {
    return <p className="muted account-status">云端状态检测中…</p>
  }
  if (snap.phase === 'unavailable') {
    return (
      <p className="muted account-status">
        云端不可用（离线或服务未部署）——本地练习、编辑与导入导出功能不受影响。
      </p>
    )
  }

  const run = async (action: () => Promise<void>, okText: string): Promise<void> => {
    setFeedback(null)
    try {
      await action()
      setFeedback({ ok: true, text: okText })
    } catch (err) {
      if (err instanceof ApiUnavailableError) setFeedback({ ok: false, text: '云端不可用，请稍后再试' })
      else if (err instanceof ApiError) setFeedback({ ok: false, text: err.message })
      else setFeedback({ ok: false, text: '操作失败，请稍后再试' })
    }
  }

  const feedbackSpan = feedback && (
    <span className={`settings-test ${feedback.ok ? 'settings-test-ok' : 'settings-test-bad'}`}>{feedback.text}</span>
  )

  if (!snap.user) {
    const isRegister = mode === 'register'
    const submit = (): void => {
      if (isRegister && confirm !== password) {
        setFeedback({ ok: false, text: '两次输入的密码不一致' })
        return
      }
      void run(
        () => (isRegister ? register(nickname, password) : login(nickname, password)),
        isRegister ? '注册成功，已登录' : '登录成功',
      ).then(() => {
        // 成功后清空表单（失败保留输入便于修正）
        if (getAccountSnapshot().user) {
          setNickname('')
          setPassword('')
          setConfirm('')
        }
      })
    }
    const onEnter = (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter') submit()
    }
    return (
      <div className="settings-form account-form">
        <div className="account-mode">
          <button
            type="button"
            className={isRegister ? '' : 'active'}
            onClick={() => {
              setMode('login')
              setFeedback(null)
            }}
          >
            登录
          </button>
          <button
            type="button"
            className={isRegister ? 'active' : ''}
            onClick={() => {
              setMode('register')
              setFeedback(null)
            }}
          >
            注册
          </button>
        </div>
        <label>
          昵称
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="2–24 个字符" />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 8 位"
            onKeyDown={onEnter}
          />
        </label>
        {isRegister && (
          <label>
            确认密码
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={onEnter} />
          </label>
        )}
        <div className="settings-actions">
          <button type="button" className="primary" disabled={snap.busy} onClick={submit}>
            {isRegister ? '创建账号' : '登录'}
          </button>
          {feedbackSpan}
        </div>
        <p className="muted settings-hint">
          {isRegister ? '注册无需邮箱；密码丢失需联系管理员重置。' : '忘记密码？联系管理员重置。'}
        </p>
      </div>
    )
  }

  const user = snap.user
  const submitNickname = (): void => {
    const value = newNickname.trim()
    if (!value) return
    void run(() => updateNickname(value), '昵称已更新').then(() => {
      if (getAccountSnapshot().user?.nickname === value) setNewNickname('')
    })
  }
  const submitPassword = (): void => {
    void run(() => changePassword(oldPassword, newPassword), '密码已更新').then(() => {
      setOldPassword('')
      setNewPassword('')
    })
  }
  return (
    <div className="settings-form account-form">
      <p className="account-current">
        当前账号：<b>{user.nickname}</b>
        {user.role === 'admin' && <span className="account-badge">管理员</span>}
      </p>
      <label>
        修改昵称
        <input value={newNickname} onChange={(e) => setNewNickname(e.target.value)} placeholder={user.nickname} />
      </label>
      <div className="settings-actions">
        <button type="button" disabled={snap.busy || newNickname.trim() === ''} onClick={submitNickname}>
          保存昵称
        </button>
        <button type="button" disabled={snap.busy} onClick={() => void run(() => logout(), '已退出登录')}>
          退出登录
        </button>
        {feedbackSpan}
      </div>
      <h3>修改密码</h3>
      <label>
        当前密码
        <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
      </label>
      <label>
        新密码（至少 8 位）
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
      </label>
      <div className="settings-actions">
        <button
          type="button"
          disabled={snap.busy || oldPassword === '' || newPassword === ''}
          onClick={submitPassword}
        >
          修改密码
        </button>
      </div>
      <p className="muted settings-hint">修改密码后，其他设备上的登录会自动退出。</p>
    </div>
  )
}
