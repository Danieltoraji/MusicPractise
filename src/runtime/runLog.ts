/**
 * 运行日志（千星「节点图日志」对应物）：试运行页收集逻辑错误与命令轨迹，
 * 经 sessionStorage 按 levelId 持久化——试运行页（#/level/:id）与节点图编辑页
 * （#/edit/:id）是互斥路由，回编辑器后仍可查看并定位节点。
 */

export interface RunLogEntry {
  kind: 'error' | 'command'
  /** error: 错误消息 */
  message?: string
  /** command: 命令路径（实例id.方法） */
  path?: string
  /** error 关联的节点 id（GraphEngine fail 的 context），可定位 */
  nodeId?: string
  /** 触发该处理器的源事件 */
  event?: string
  t: number
}

const KEY_PREFIX = 'runlog:'
const MAX_ENTRIES = 50

function key(levelId: string): string {
  return `${KEY_PREFIX}${levelId}`
}

export function appendRunLog(levelId: string, entry: RunLogEntry): void {
  try {
    const log = readRunLog(levelId)
    log.push(entry)
    const trimmed = log.slice(-MAX_ENTRIES)
    sessionStorage.setItem(key(levelId), JSON.stringify(trimmed))
  } catch {
    // sessionStorage 不可用（隐私模式等）：日志降级为无持久化，不影响运行
  }
}

export function readRunLog(levelId: string): RunLogEntry[] {
  try {
    const raw = sessionStorage.getItem(key(levelId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as RunLogEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function clearRunLog(levelId: string): void {
  try {
    sessionStorage.removeItem(key(levelId))
  } catch {
    // ignore
  }
}
