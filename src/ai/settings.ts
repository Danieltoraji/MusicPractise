/**
 * AI 接入设置的持久化。
 *
 * 惯例与 graph-theme（GraphEditor 深浅主题）一致：localStorage 裸 kebab-case 键。
 * API Key 明文存本机浏览器——纯静态站没有后端可托管密钥，设置页 UI 已注明「仅存本机」。
 *
 * 结构：{ activeId, profiles }，profiles 以档案 id 为键（预设 id 固定，自定义 id 前缀 custom-）。
 * 读取时把缺失的预设合并进 profiles（保证后续版本新增预设自动出现），已存值优先。
 */

import { PRESET_BY_ID, PROVIDER_PRESETS, isCustomProfileId } from './providers'

export const AI_SETTINGS_KEY = 'ai-settings'

export interface AiProviderProfile {
  name: string
  baseUrl: string
  model: string
  apiKey: string
}

export interface AiSettings {
  /** 当前激活的供应商档案 id */
  activeId: string
  profiles: Record<string, AiProviderProfile>
}

export function profileFromPreset(id: string): AiProviderProfile {
  const preset = PRESET_BY_ID[id]
  return {
    name: preset?.name ?? id,
    baseUrl: preset?.baseUrl ?? '',
    model: preset?.defaultModel ?? '',
    apiKey: '',
  }
}

export function defaultAiSettings(): AiSettings {
  const profiles: Record<string, AiProviderProfile> = {}
  for (const p of PROVIDER_PRESETS) profiles[p.id] = profileFromPreset(p.id)
  return { activeId: PROVIDER_PRESETS[0].id, profiles }
}

/** 逐字段清洗单个档案；结构不合法返回 null（调用方丢弃） */
function sanitizeProfile(raw: unknown): AiProviderProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    name: str(r.name),
    baseUrl: str(r.baseUrl),
    model: str(r.model),
    apiKey: str(r.apiKey),
  }
}

export function sanitizeAiSettings(raw: unknown): AiSettings {
  const base = defaultAiSettings()
  if (typeof raw !== 'object' || raw === null) return base
  const r = raw as Record<string, unknown>
  if (typeof r.profiles !== 'object' || r.profiles === null) return base

  const profiles: Record<string, AiProviderProfile> = { ...base.profiles }
  for (const [id, value] of Object.entries(r.profiles as Record<string, unknown>)) {
    const cleaned = sanitizeProfile(value)
    if (!cleaned) continue
    if (PRESET_BY_ID[id]) {
      // 预设档案：用户改过的字段优先，但保留预设名做展示锚点
      profiles[id] = { ...cleaned, name: PRESET_BY_ID[id].name }
    } else if (isCustomProfileId(id) && (cleaned.baseUrl || cleaned.name)) {
      profiles[id] = cleaned
    }
  }

  const activeId =
    typeof r.activeId === 'string' && profiles[r.activeId] ? r.activeId : PROVIDER_PRESETS[0].id
  return { activeId, profiles }
}

export function loadAiSettings(): AiSettings {
  try {
    const text = localStorage.getItem(AI_SETTINGS_KEY)
    if (!text) return defaultAiSettings()
    return sanitizeAiSettings(JSON.parse(text))
  } catch {
    // 毒数据 / localStorage 被禁用：回落默认，绝不阻断页面
    return defaultAiSettings()
  }
}

export function saveAiSettings(settings: AiSettings): void {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings))
}
