import { describe, expect, it } from 'vitest'
import { CUSTOM_ID_PREFIX, PRESET_BY_ID, PROVIDER_PRESETS, isCustomProfileId, newCustomProfileId } from './providers'

describe('AI 供应商预设注册表', () => {
  it('预设 id 唯一，baseUrl 为 https 端点且默认模型在建议列表内', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PROVIDER_PRESETS) {
      expect(p.baseUrl).toMatch(/^https:\/\//)
      expect(p.baseUrl.endsWith('/')).toBe(false)
      expect(p.models.some((s) => s.id === p.defaultModel)).toBe(true)
      expect(p.models.every((s) => s.id.trim() !== '' && !s.id.includes('（'))).toBe(true)
      expect(p.name.length).toBeGreaterThan(0)
    }
  })

  it('覆盖用户点名的 DeepSeek / GLM / ChatGPT（OpenAI）', () => {
    expect(PRESET_BY_ID['deepseek']?.baseUrl).toContain('deepseek.com')
    expect(PRESET_BY_ID['glm']?.baseUrl).toContain('bigmodel.cn')
    expect(PRESET_BY_ID['openai']?.baseUrl).toContain('openai.com')
  })

  it('自定义档案 id 程序化生成、带前缀、不重复', () => {
    const a = newCustomProfileId()
    const b = newCustomProfileId()
    expect(a).toMatch(new RegExp(`^${CUSTOM_ID_PREFIX}`))
    expect(a).not.toBe(b)
    expect(isCustomProfileId(a)).toBe(true)
    expect(isCustomProfileId('deepseek')).toBe(false)
  })
})
