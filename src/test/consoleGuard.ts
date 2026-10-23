/**
 * console 失败门禁工具（docs/44 R15 / docs/40 H2 起步）。
 *
 * 目的：让「测试期间出现未预期的 console.error/warn」变成可断言的失败，而不是被输出淹没。
 * 兼容既有负向用例：通过 `allow` 正则放行预期日志（例如错误分支测试会打印的校验错误）。
 *
 * 用法：
 *   await withConsoleGuard('保存失败分支', async () => { ... }, { allow: [/保存失败/] })
 *   const logs = await captureConsole(() => { ... })  // 需要断言日志内容时用
 */

export interface ConsoleGuardOptions {
  /** 允许出现的 console.error/warn 文案（正则）；未命中一律视为违规 */
  allow?: RegExp[]
}

/** console 日志捕获结果（含级别便于断言） */
export interface CapturedConsoleLog {
  level: 'error' | 'warn'
  text: string
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

/**
 * 执行 fn 并捕获期间的 console.error/warn；fn 正常结束后若存在未被 `allow` 放行的日志，
 * 抛出带全部违规文案的 Error。fn 本身抛错时保留原错误（不掩盖真实失败），但仍会恢复 console。
 */
export async function withConsoleGuard<T>(
  label: string,
  fn: () => T | Promise<T>,
  opts: ConsoleGuardOptions = {},
): Promise<T> {
  const logs: CapturedConsoleLog[] = []
  const originalError = console.error
  const originalWarn = console.warn
  console.error = (...args: unknown[]): void => {
    logs.push({ level: 'error', text: args.map(formatArg).join(' ') })
  }
  console.warn = (...args: unknown[]): void => {
    logs.push({ level: 'warn', text: args.map(formatArg).join(' ') })
  }
  let failed = false
  let failure: unknown
  let result: T | undefined
  try {
    result = await fn()
  } catch (err) {
    failed = true
    failure = err
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }
  if (failed) throw failure
  const unexpected = logs.filter(
    (log) => !(opts.allow ?? []).some((re) => re.test(log.text)),
  )
  if (unexpected.length > 0) {
    throw new Error(
      `[consoleGuard] ${label} 期间出现 ${unexpected.length} 条非预期 console 输出：\n` +
        unexpected.map((log) => `  [${log.level}] ${log.text}`).join('\n'),
    )
  }
  return result as T
}

/** 仅捕获日志（不判定失败）：用于断言错误分支确实打印了可读消息 */
export async function captureConsole<T>(fn: () => T | Promise<T>): Promise<{ result: T; logs: CapturedConsoleLog[] }> {
  const logs: CapturedConsoleLog[] = []
  const originalError = console.error
  const originalWarn = console.warn
  console.error = (...args: unknown[]): void => {
    logs.push({ level: 'error', text: args.map(formatArg).join(' ') })
  }
  console.warn = (...args: unknown[]): void => {
    logs.push({ level: 'warn', text: args.map(formatArg).join(' ') })
  }
  try {
    const result = await fn()
    return { result, logs }
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }
}
