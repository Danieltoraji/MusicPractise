import { describe, expect, it } from 'vitest'
import { detectVision } from './vision'

describe('detectVision（视觉模型三分判定）', () => {
  it('已知视觉模型 → vision', () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'GPT-4.1', 'glm-4v-plus', 'qwen-vl-max', 'qwen/qwen-2.5-vl-72b-instruct', 'claude-sonnet-4.5', 'gemini-2.0-flash', 'moonshot-v1-8k-vision-preview']) {
      expect(detectVision(model)).toBe('vision')
    }
  })

  it('已知纯文本预设模型 → text（附图时面板提示）', () => {
    for (const model of ['deepseek-chat', 'deepseek-reasoner', 'kimi-k2-0905-preview', 'moonshot-v1-8k', 'glm-4.6', 'glm-4-flash', 'qwen-plus', 'qwen-max', 'o4-mini']) {
      expect(detectVision(model)).toBe('text')
    }
  })

  it('自定义/未知模型与空名 → unknown（不提示，避免误报）', () => {
    for (const model of ['my-proxy-model', 'default', 'gpt-x-custom', '']) {
      expect(detectVision(model)).toBe('unknown')
    }
  })

  it('带 vision 片段的名字优先于 text 判定（先查 vision）', () => {
    expect(detectVision('moonshot-v1-8k-vision-preview')).toBe('vision')
  })
})
