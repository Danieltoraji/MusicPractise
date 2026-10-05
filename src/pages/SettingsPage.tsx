/**
 * 设置页（#/settings）：AI 接入配置。
 *
 * 左侧预设供应商卡片 + 自定义档案；右侧当前档案表单（名称/BaseURL/模型/Key）。
 * 编辑只改本地 state，点「保存设置」才写入 localStorage——避免误触即落盘。
 * 「测试连接」用当前表单值（含未保存的修改）发一条最小对话。
 */

import { useState } from 'react'
import { AiClientError, testConnection } from '../ai/client'
import { PRESET_BY_ID, PROVIDER_PRESETS, isCustomProfileId, newCustomProfileId } from '../ai/providers'
import { loadAiSettings, saveAiSettings, type AiProviderProfile, type AiSettings } from '../ai/settings'
import { getMasterVolume, playNotes, setMasterVolume } from '../runtime/audio'

interface TestResult {
  ok: boolean
  text: string
}

export function SettingsPage() {
  const [settings, setSettings] = useState<AiSettings>(() => loadAiSettings())
  const [notice, setNotice] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  // 音量即改即存（不混入 AI 设置的「保存设置」）；试听顺带验证钢琴发声链
  const [volume, setVolumeState] = useState(() => getMasterVolume())
  const applyVolume = (v: number): void => {
    setVolumeState(v)
    setMasterVolume(v)
  }

  const profile: AiProviderProfile | undefined = settings.profiles[settings.activeId]
  const isCustom = isCustomProfileId(settings.activeId)
  const preset = PRESET_BY_ID[settings.activeId]

  const mutate = (fn: (s: AiSettings) => AiSettings) => {
    setSettings((s) => fn(s))
    setNotice('')
  }

  const selectProvider = (id: string) => {
    mutate((s) => ({ ...s, activeId: id }))
    setTestResult(null)
    setShowKey(false)
  }

  const patchActive = (patch: Partial<AiProviderProfile>) => {
    mutate((s) => ({
      ...s,
      profiles: { ...s.profiles, [s.activeId]: { ...s.profiles[s.activeId], ...patch } },
    }))
  }

  const addCustom = () => {
    const id = newCustomProfileId()
    mutate((s) => ({
      ...s,
      activeId: id,
      profiles: { ...s.profiles, [id]: { name: '自定义供应商', baseUrl: '', model: '', apiKey: '' } },
    }))
    setTestResult(null)
  }

  const removeCustom = (id: string) => {
    mutate((s) => {
      const profiles = { ...s.profiles }
      delete profiles[id]
      return { activeId: s.activeId === id ? PROVIDER_PRESETS[0].id : s.activeId, profiles }
    })
    setTestResult(null)
  }

  const save = () => {
    try {
      saveAiSettings(settings)
      setNotice('已保存')
    } catch (err) {
      setNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const runTest = async () => {
    if (!profile || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const r = await testConnection(profile)
      setTestResult({ ok: true, text: `连接成功（${r.latencyMs} ms）· 模型应答：${r.reply || '（空）'}` })
    } catch (err) {
      const msg = err instanceof AiClientError ? err.message : err instanceof Error ? err.message : String(err)
      setTestResult({ ok: false, text: msg })
    } finally {
      setTesting(false)
    }
  }

  const customIds = Object.keys(settings.profiles).filter(isCustomProfileId)

  return (
    <div className="page settings-page">
      <h1>设置</h1>
      <p className="muted">
        配置 AI 接入，供编辑器的 AI 辅助功能（伪代码生成、节点图解释、题目与关卡生成）使用。
        API Key 仅保存在本机浏览器的 localStorage 中，不会上传到任何服务器；请勿在共享电脑上保存 Key。
      </p>

      <h2>AI 供应商</h2>
      <div className="provider-cards">
        {PROVIDER_PRESETS.map((p) => {
          const prof = settings.profiles[p.id]
          return (
            <button
              key={p.id}
              type="button"
              className={`provider-card${settings.activeId === p.id ? ' active' : ''}`}
              onClick={() => selectProvider(p.id)}
            >
              <b>{p.name}</b>
              <span className="provider-card-url">{p.baseUrl}</span>
              <span className="provider-card-meta">
                {prof?.apiKey ? '✓ 已配置 Key' : '未配置 Key'} · {prof?.model || p.defaultModel}
              </span>
            </button>
          )
        })}
        {customIds.map((id) => {
          const prof = settings.profiles[id]
          return (
            <div
              key={id}
              className={`provider-card provider-card-custom${settings.activeId === id ? ' active' : ''}`}
            >
              <button type="button" className="provider-card-body" onClick={() => selectProvider(id)}>
                <b>{prof?.name || '自定义供应商'}</b>
                <span className="provider-card-url">{prof?.baseUrl || '（未填 API 地址）'}</span>
                <span className="provider-card-meta">{prof?.apiKey ? '✓ 已配置 Key' : '未配置 Key'}</span>
              </button>
              <button
                type="button"
                className="provider-card-remove"
                title="删除该自定义供应商"
                onClick={() => removeCustom(id)}
              >
                ✕
              </button>
            </div>
          )
        })}
        <button type="button" className="provider-card provider-add" onClick={addCustom}>
          ＋ 添加自定义供应商
        </button>
      </div>

      {profile && (
        <div className="settings-form">
          <h3>{isCustom ? '自定义供应商配置' : `配置 · ${preset?.name ?? profile.name}`}</h3>
          {isCustom && (
            <label>
              名称
              <input value={profile.name} onChange={(e) => patchActive({ name: e.target.value })} />
            </label>
          )}
          <label>
            API 地址（Base URL，OpenAI 兼容，通常以 /v1 结尾）
            <input
              value={profile.baseUrl}
              placeholder="https://…/v1"
              onChange={(e) => patchActive({ baseUrl: e.target.value })}
            />
          </label>
          <label>
            模型
            <input
              value={profile.model}
              list="ai-model-suggestions"
              placeholder="如 deepseek-chat"
              onChange={(e) => patchActive({ model: e.target.value })}
            />
            <datalist id="ai-model-suggestions">
              {(preset?.models ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                  {s.vision ? '（视觉：支持图像输入）' : ''}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            API Key
            <span className="key-row">
              <input
                type={showKey ? 'text' : 'password'}
                value={profile.apiKey}
                placeholder="sk-…"
                autoComplete="off"
                onChange={(e) => patchActive({ apiKey: e.target.value })}
              />
              <button type="button" className="key-toggle" onClick={() => setShowKey((v) => !v)}>
                {showKey ? '隐藏' : '显示'}
              </button>
            </span>
          </label>

          <div className="settings-actions">
            <button type="button" onClick={runTest} disabled={testing}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            {testResult && (
              <span className={`settings-test ${testResult.ok ? 'settings-test-ok' : 'settings-test-bad'}`}>
                {testResult.text}
              </span>
            )}
          </div>
          <p className="muted settings-hint">
            测试连接使用当前表单值（无需先保存）。若提示无法连接，多为该服务不允许浏览器跨域直连，可改用
            OpenRouter 或自定义兼容代理地址。
          </p>
        </div>
      )}

      <h2>音频</h2>
      <div className="settings-audio">
        <label className="audio-volume">
          <span>主音量（影响钢琴 / 合成器 / 节拍点击）</span>
          <span className="audio-volume-row">
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(volume * 100)}
              onChange={(e) => applyVolume(Number(e.target.value) / 100)}
            />
            <b>{Math.round(volume * 100)}%</b>
            <button
              type="button"
              onClick={() => playNotes([{ midi: 60 }, { midi: 64, t: 1 }, { midi: 67, t: 1 }, { midi: 72, t: 2 }], 120)}
              title="播放一串琶音试听"
            >
              ▶ 试听
            </button>
          </span>
        </label>
        <p className="muted">音量保存于本机浏览器（此设备所有关卡生效）。</p>
      </div>

      <div className="settings-save">
        <button type="button" className="primary" onClick={save}>
          保存设置
        </button>
        {notice && <span className="muted">{notice}</span>}
      </div>
    </div>
  )
}
