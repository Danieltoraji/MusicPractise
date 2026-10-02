/**
 * AI 供应商预设注册表。
 *
 * 所有预设均提供 OpenAI 兼容的 `/chat/completions` 端点，client.ts 只实现这一种协议；
 * 不兼容的供应商可通过「自定义」填入兼容网关地址（如 OpenRouter / 自建代理）。
 * 模型名迭代很快，预设只给建议值，设置页允许自由输入。
 */

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  defaultModel: string
  /** 模型建议（设置页 datalist 候选，可自由输入之外的值） */
  models: string[]
  note?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: 'deepseek-chat 通用对话；deepseek-reasoner 深度推理（较慢）',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.6',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-flash'],
  },
  {
    id: 'openai',
    name: 'OpenAI（ChatGPT）',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-8k', 'moonshot-v1-32k'],
  },
  {
    id: 'qwen',
    name: '通义千问 Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    models: ['openrouter/auto', 'deepseek/deepseek-chat', 'openai/gpt-4o-mini', 'anthropic/claude-sonnet-4.5'],
    note: '聚合网关：一个 Key 调多家模型；其他供应商浏览器直连受阻时的备选',
  },
]

/** 预设 id → 预设（设置页判断激活档案是否为预设） */
export const PRESET_BY_ID: Record<string, ProviderPreset> = Object.fromEntries(
  PROVIDER_PRESETS.map((p) => [p.id, p]),
)

/** 自定义供应商档案 id 前缀（id 程序化生成，禁止手写） */
export const CUSTOM_ID_PREFIX = 'custom-'

export function isCustomProfileId(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX)
}

/** 新自定义档案 id：前缀 + 随机后缀（同 newResourceId 的程序化生成精神） */
export function newCustomProfileId(): string {
  let suffix = ''
  for (let i = 0; i < 8; i++) suffix += Math.floor(Math.random() * 36).toString(36)
  return `${CUSTOM_ID_PREFIX}${suffix}`
}
