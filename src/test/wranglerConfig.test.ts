/**
 * R41：wrangler.jsonc 部署路由静态守卫。
 *
 * 背景：wrangler 4.147 的 config schema 要求 `run_worker_first` 属于 `assets`
 * （顶层字段会被忽略并告警；生产上 `/api/*` 可能先命中 SPA fallback 而不是 Worker）。
 * 该配置无法被 jsdom 覆盖，故用 source 级断言锁住。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function readConfig(): Record<string, unknown> {
  const raw = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')
  // 仅去掉整行注释（config 内没有内联注释/字符串里的 // 行首情况），保留 JSONC 其余部分。
  const stripped = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  return JSON.parse(stripped) as Record<string, unknown>
}

describe('wrangler 配置（R41）', () => {
  it('run_worker_first 位于 assets 内且只路由 /api/*', () => {
    const config = readConfig()
    const assets = config.assets as Record<string, unknown>
    expect(Array.isArray(config.run_worker_first)).toBe(false) // 顶层字段已移走
    expect(assets.run_worker_first).toEqual(['/api/*'])
    expect(assets.binding).toBe('ASSETS')
    expect(assets.directory).toBe('./dist')
    expect(assets.not_found_handling).toBe('single-page-application')
  })

  it('Worker 与 D1 绑定名与运行时约定一致', () => {
    const config = readConfig()
    expect(config.main).toBe('worker/index.ts')
    const d1 = (config.d1_databases as Record<string, unknown>[])[0]
    expect(d1.binding).toBe('DB')
    expect(d1.database_name).toBe('musicpractise-db')
  })
})
