// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AI_SETTINGS_KEY,
  defaultAiSettings,
  loadAiSettings,
  sanitizeAiSettings,
  saveAiSettings,
} from './settings'

beforeEach(() => {
  localStorage.clear()
})

describe('AI 设置持久化', () => {
  it('默认配置：全部预设建档、激活第一个、Key 为空', () => {
    const s = defaultAiSettings()
    expect(s.activeId).toBe('deepseek')
    for (const id of ['deepseek', 'glm', 'openai', 'openrouter']) {
      expect(s.profiles[id].baseUrl).toMatch(/^https:/)
      expect(s.profiles[id].apiKey).toBe('')
    }
  })

  it('空存储 load → 默认配置', () => {
    expect(loadAiSettings()).toEqual(defaultAiSettings())
  })

  it('save → load 往返一致（Key 与改过的模型都保留）', () => {
    const s = defaultAiSettings()
    s.profiles['deepseek'].apiKey = 'sk-test'
    s.profiles['deepseek'].model = 'deepseek-reasoner'
    s.activeId = 'glm'
    saveAiSettings(s)
    expect(loadAiSettings()).toEqual(s)
  })

  it('坏 JSON / 毒数据不抛错，回落默认', () => {
    localStorage.setItem(AI_SETTINGS_KEY, '{oops')
    expect(loadAiSettings()).toEqual(defaultAiSettings())
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify({ activeId: 1, profiles: 'nope' }))
    expect(loadAiSettings()).toEqual(defaultAiSettings())
  })

  it('sanitize：缺失的预设自动补齐、预设档案保留预设名、非法档案与非法 activeId 丢弃', () => {
    const merged = sanitizeAiSettings({
      activeId: 'gone',
      profiles: {
        deepseek: { name: '被改的名字', baseUrl: 'https://x.example/v1', model: 'm', apiKey: 'k' },
        junk: 'not-an-object',
      },
    })
    // 缺失的预设补齐
    expect(Object.keys(merged.profiles)).toContain('glm')
    // 预设档案：用户字段优先，名称锚回预设名
    expect(merged.profiles['deepseek']).toEqual({
      name: 'DeepSeek',
      baseUrl: 'https://x.example/v1',
      model: 'm',
      apiKey: 'k',
    })
    expect(merged.profiles['junk']).toBeUndefined()
    // activeId 指向不存在的档案 → 回落第一个预设
    expect(merged.activeId).toBe('deepseek')
  })

  it('sanitize：合法自定义档案保留并可激活', () => {
    const merged = sanitizeAiSettings({
      activeId: 'custom-abc',
      profiles: {
        'custom-abc': { name: '我的网关', baseUrl: 'https://gw.example/v1', model: 'm1', apiKey: 'k' },
      },
    })
    expect(merged.profiles['custom-abc']).toEqual({
      name: '我的网关',
      baseUrl: 'https://gw.example/v1',
      model: 'm1',
      apiKey: 'k',
    })
    expect(merged.activeId).toBe('custom-abc')
  })

  it('sanitize：无名称无地址的自定义残片丢弃', () => {
    const merged = sanitizeAiSettings({
      profiles: { 'custom-x': { name: '', baseUrl: '', model: 'm', apiKey: '' } },
    })
    expect(merged.profiles['custom-x']).toBeUndefined()
  })
})
