// @vitest-environment jsdom
// dirty-guard 的 hashchange 捕获 handler 单测（评审 P0-1 回归：回声抑制/取消回滚/确定放行）
import { describe, expect, it, vi } from 'vitest'
import { makeDirtyHashHandler } from './dirtyGuard'

function harness(initialHash: string, dirty: boolean, confirmResult: boolean) {
  const dirtyRef = { current: dirty }
  const prevHashRef = { current: initialHash }
  const confirm = vi.fn(() => confirmResult)
  let locationHash = initialHash
  const handler = makeDirtyHashHandler({
    dirtyRef,
    prevHashRef,
    confirm,
    getLocationHash: () => locationHash,
    rollback: (h) => {
      locationHash = h
    },
  })
  const fire = (to: string) => {
    locationHash = to
    handler(new HashChangeEvent('hashchange'))
  }
  return { handler, confirm, prevHashRef, fire }
}

describe('makeDirtyHashHandler（dirty-guard）', () => {
  it('干净状态：无 confirm，prevHash 跟进', () => {
    const h = harness('#/edit/A', false, false)
    h.fire('#/library')
    console.log('[dbg]', JSON.stringify({ confirmCalls: h.confirm.mock.calls.length, prev: h.prevHashRef.current }))
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.prevHashRef.current).toBe('#/library')
  })

  it('脏 + 确认离开：放行并清脏', () => {
    const h = harness('#/edit/A', true, true)
    h.fire('#/library')
    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.prevHashRef.current).toBe('#/library')
  })

  it('脏 + 取消：confirm 一次并回滚 hash；回滚引发的 hashchange 回声不再二次 confirm（P0 回归）', () => {
    const h = harness('#/edit/A', true, false)
    h.fire('#/library') // 用户取消 → 回滚到 A
    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.prevHashRef.current).toBe('#/edit/A')
    // 回滚操作自身触发的 hashchange（hash 已回到 A）：回声抑制，不重复 confirm
    h.fire('#/edit/A')
    expect(h.confirm).toHaveBeenCalledTimes(1)
  })

  it('脏 + 取消后再次真实导航：仍会再确认一次（用户仍脏）', () => {
    const h = harness('#/edit/A', true, false)
    h.fire('#/library')
    expect(h.confirm).toHaveBeenCalledTimes(1)
    h.fire('#/level/B')
    expect(h.confirm).toHaveBeenCalledTimes(2)
  })

  it('脏 + 回滚后再导航：prevHash 已更新，正常再确认一次', () => {
    const h = harness('#/edit/A', true, false)
    h.fire('#/library') // 取消 → 回滚 A
    h.fire('#/level/B') // 再导航（仍脏）→ 再确认
    expect(h.confirm).toHaveBeenCalledTimes(2)
  })
})
