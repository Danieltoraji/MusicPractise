/**
 * H2（docs/44 R20）：全局 console 失败门禁。
 *
 * R15 已有 `withConsoleGuard`（opt-in，按用例包住区域）；本模块把它升级为**全局默认**：
 * 每个测试结束时，若期间出现未被放行的 `console.error`/`console.warn`，该测试失败。
 *
 * 兼容性：
 * - 负向用例仍可用 `withConsoleGuard(..., { allow: [...] })` 包住预期日志区域——包住期间
 *   全局 wrapper 被替换，门禁自然不重复判定；
 * - 全局放行表 `GLOBAL_ALLOW` 只收「已知平台噪音」（如 React act 警告、jsdom 未实现能力），
 *   不收应用自身错误——新增噪音应修复或用例内显式 allow；
 * - `CONSOLE_GATE_REPORT=1` 时只把违规写入 `tmp-console-gate.log`（用于建立基线），不失败。
 */
import { appendFileSync } from 'node:fs'
import { afterEach, beforeEach } from 'vitest'

/** 全局放行：只收测试环境噪音，禁止加入应用业务错误 */
const GLOBAL_ALLOW: RegExp[] = [
  // React 19 在测试中异步 state 更新未包 act 的提醒（属于测试写法噪音，不是应用日志）
  /not wrapped in act\(\.\.\.\)/,
  /An update to .* inside a test was not wrapped in act/,
  // jsdom 未实现能力（R15 已替身 canvas/scroll；残留能力统一视为平台噪音）
  /Not implemented: /,
  // ---------------------------------------------------------------------------
  // 以下为「测试夹具故意构造非法文档」触发的应用诊断日志：用例本身就在验证
  // 降级/错误分支（例如未知组件类型、废弃 mode 折算、坏事件图预算拦截），
  // 这些日志是预期契约的一部分，不是回归信号。
  // ---------------------------------------------------------------------------
  /\[session\] 逻辑 lint:/, // 装载 lint（F6）与运行时夹具的悬空事件/视图告警
  /\[session\] flow\.pass 求值失败/, // 过关表达式负向用例（按未通过降级）
  /\[session\] 命令执行失败/, // 未知实例命令负向用例（产生 error 事件）
  /\[logic\] .*(Error|ExprError):/, // 执行器对坏夹具的运行时诊断（事件预算/表达式错误）
  /\[store\] 未知组件类型/, // 未知组件降级测试
  /\[(?:synth|sound)\] mode 参数已废弃/, // 废弃 mode 兼容折算测试
  /\[audio\] 未知时值/, // 时值回退测试
  /\[boundary\] 渲染异常/, // ErrorBoundary 负向用例：故意让子组件抛错
]

const REPORT = process.env.CONSOLE_GATE_REPORT === '1'
const REPORT_PATH = 'tmp-console-gate.log'

interface GateLog {
  level: 'error' | 'warn'
  text: string
}

let installed = false
let buffer: GateLog[] = []
let currentTest = '<unknown>'

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

/** 是否已安装全局门禁（测试用；随 setup 每个 worker 安装一次） */
export function isConsoleGateInstalled(): boolean {
  return installed
}

/** 安装全局门禁（setup.ts 调用一次；重复调用无副作用） */
export function installConsoleGate(): void {
  if (installed) return
  installed = true

  const originalError = console.error
  const originalWarn = console.warn
  console.error = (...args: unknown[]): void => {
    buffer.push({ level: 'error', text: args.map(formatArg).join(' ') })
    originalError.apply(console, args)
  }
  console.warn = (...args: unknown[]): void => {
    buffer.push({ level: 'warn', text: args.map(formatArg).join(' ') })
    originalWarn.apply(console, args)
  }

  beforeEach((ctx) => {
    buffer = []
    currentTest = ctx?.task?.name ?? '<unknown>'
  })

  afterEach(() => {
    const logs = buffer
    buffer = []
    const unexpected = logs.filter((log) => !GLOBAL_ALLOW.some((re) => re.test(log.text)))
    if (unexpected.length === 0) return
    const detail =
      `[consoleGate] ${currentTest} 期间出现 ${unexpected.length} 条非预期 console 输出：\n` +
      unexpected.map((log) => `  [${log.level}] ${log.text}`).join('\n')
    if (REPORT) {
      // 报告模式：只记录，不失败（用于建立 allowlist/修噪音的基线）
      console.info(`[consoleGate:report] ${detail}`)
      appendFileSync(REPORT_PATH, `${detail}\n---\n`)
      return
    }
    throw new Error(detail)
  })
}
