/**
 * dirty-guard 的 hashchange 捕获 handler（评审 P0-1 回归锚）。
 * 从 EditorPage 抽出以便单测：回声抑制（回滚触发的第二次 hashchange 直接放行，
 * 不再弹二次 confirm）、脏时 confirm、取消回滚 hash、确认放行并清脏。
 */
import type { RefObject } from 'react'

export interface DirtyHashGuardDeps {
  dirtyRef: RefObject<boolean>
  prevHashRef: RefObject<string>
  confirm: (message: string) => boolean
  /** 当前 hash（注入以便单测；生产传 () => window.location.hash） */
  getLocationHash: () => string
  /** 回滚路由（生产赋 window.location.hash） */
  rollback: (hash: string) => void
}

export function makeDirtyHashHandler(deps: DirtyHashGuardDeps) {
  return (e: HashChangeEvent): void => {
    if (deps.getLocationHash() === deps.prevHashRef.current) return // 回滚/无变化的回声
    if (!deps.dirtyRef.current) {
      deps.prevHashRef.current = deps.getLocationHash()
      return
    }
    if (deps.confirm('有未保存的更改，离开将丢失。确定离开吗？')) {
      deps.prevHashRef.current = deps.getLocationHash()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    deps.rollback(deps.prevHashRef.current) // 回滚到离开前的路由
  }
}
