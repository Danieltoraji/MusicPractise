// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { appendRunLog, clearRunLog, readRunLog } from './runLog'

beforeEach(() => {
  sessionStorage.clear()
})

describe('runLog（运行日志持久化）', () => {
  it('写入/读取往返', () => {
    appendRunLog('lv1', { kind: 'command', path: 'sound1.play', t: 1 })
    appendRunLog('lv1', { kind: 'error', message: '未知实例 "x"', nodeId: 'n3', event: 'a.b', t: 2 })
    const log = readRunLog('lv1')
    expect(log).toHaveLength(2)
    expect(log[0]).toEqual({ kind: 'command', path: 'sound1.play', t: 1 })
    expect(log[1]).toMatchObject({ kind: 'error', nodeId: 'n3' })
    // 按 levelId 隔离
    expect(readRunLog('lv2')).toEqual([])
  })

  it('上限 50 条（保留最新）', () => {
    for (let i = 0; i < 60; i++) appendRunLog('lv', { kind: 'command', path: `c${i}`, t: i })
    const log = readRunLog('lv')
    expect(log).toHaveLength(50)
    expect(log[0].path).toBe('c10')
    expect(log[49].path).toBe('c59')
  })

  it('清空与损坏数据容错', () => {
    appendRunLog('lv', { kind: 'command', path: 'x', t: 1 })
    clearRunLog('lv')
    expect(readRunLog('lv')).toEqual([])
    sessionStorage.setItem('runlog:lv', '{broken')
    expect(readRunLog('lv')).toEqual([])
  })
})
