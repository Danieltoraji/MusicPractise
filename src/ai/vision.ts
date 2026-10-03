/**
 * 视觉模型识别（批次8a）：给「附图」体验兜底——已知纯文本模型附图时面板提示，
 * 免得用户对着 4xx 报错猜原因。模型名迭代快、自定义供应商无法判定，
 * 识别按保守三分：vision（确认支持）/ text（确认不支持）/ unknown（不提示）。
 */

/** 已知支持图像输入的模型名片段（大小写不敏感，子串匹配） */
const VISION_RE =
  /gpt-4o|gpt-4\.1|chatgpt-4o|glm-4v|qwen-vl|qwen[\d.-]*-vl|gemini|claude-(3|sonnet|opus|haiku)|vision|vl-max|vl-plus|minimax-image|doubao-vision/i

/** 已知纯文本的预设模型名片段（命中即明确提示不支持图像；带 vision 的名字先被 VISION_RE 截住） */
const TEXT_RE =
  /deepseek-chat|deepseek-reasoner|kimi-k2|moonshot-v1-8k|moonshot-v1-32k|glm-4\.6|glm-4\.5|glm-4-flash|qwen-max|qwen-plus|qwen-turbo|o3-mini|o4-mini/i

export type VisionSupport = 'vision' | 'text' | 'unknown'

/** 三分判定：确认支持 / 确认纯文本 / 未知（自定义模型多数落这里，不提示） */
export function detectVision(model: string): VisionSupport {
  const name = model.trim()
  if (name === '') return 'unknown'
  if (VISION_RE.test(name)) return 'vision'
  if (TEXT_RE.test(name)) return 'text'
  return 'unknown'
}
