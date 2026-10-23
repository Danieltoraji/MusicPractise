/**
 * consoleGuard 回归（docs/44 R15）：非预期日志变失败、allow 放行、原错误不被掩盖、捕获模式。
 */
import { describe, expect, it } from 'vitest'
import { captureConsole, withConsoleGuard } from './consoleGuard'

describe('withConsoleGuard', () => {
  it('无日志时正常返回', async () => {
    await expect(withConsoleGuard('clean', async () => 42)).resolves.toBe(42)
  })

  it('未预期的 console.warn/error → 抛错并列出全部文案', async () => {
    await expect(
      withConsoleGuard('noisy', async () => {
        console.warn('意外警告')
        console.error(new Error('意外错误'))
      }),
    ).rejects.toThrow(/\[consoleGuard\] noisy 期间出现 2 条非预期 console 输出[\s\S]*意外警告[\s\S]*Error: 意外错误/)
  })

  it('allow 正则放行预期错误分支日志', async () => {
    await expect(
      withConsoleGuard(
        'expected',
        async () => {
          console.error('保存失败：网络不可用')
          return 'ok'
        },
        { allow: [/保存失败/] },
      ),
    ).resolves.toBe('ok')
  })

  it('fn 自身抛错时保留原错误（不掩盖真实失败），且恢复 console', async () => {
    const boom = new Error('业务失败')
    await expect(
      withConsoleGuard('throws', async () => {
        console.warn('顺手打印')
        throw boom
      }),
    ).rejects.toBe(boom)
    // console 已恢复：后续调用不应再被捕获
    expect(typeof console.warn).toBe('function')
  })
})

describe('captureConsole', () => {
  it('捕获日志级别与文案并返回结果', async () => {
    const { result, logs } = await captureConsole(() => {
      console.warn('w1')
      console.error('e1')
      return 7
    })
    expect(result).toBe(7)
    expect(logs).toEqual([
      { level: 'warn', text: 'w1' },
      { level: 'error', text: 'e1' },
    ])
  })
})
