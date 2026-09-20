// @vitest-environment jsdom
// HomePage 回归：库里混有 v1/v2 旧格式关卡记录时，列表照常渲染（经迁移读取，评审修复 docs/23 后续）
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSeeded, putResource } from '../library/db'
import { HomePage } from './HomePage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement | null = null

async function renderHome(): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root!.render(<HomePage />)
  })
  // useLiveQuery 完成查询（Dexie 走 IndexedDB 异步）+ React 提交
  for (let i = 0; i < 15; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
  }
  return container
}

beforeEach(async () => {
  await db.resources.clear()
  await db.progress.clear()
  await ensureSeeded()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
})

describe('HomePage（旧格式库记录回归）', () => {
  it('库中混有 v1 旧格式关卡：首页照常渲染，旧卡经迁移显示题目数', async () => {
    // v1 形态（questions 体系，无 table/views）——与老用户库中记录同构
    await putResource({
      schemaVersion: 1,
      id: 'res_01J9D000000000000000000000',
      kind: 'level',
      version: '1.0.0',
      meta: { title: '旧版关卡', description: 'v1 时代的记录' },
      content: {
        components: [{ id: 'btn1', type: 'button' }],
        logic: { variables: { score: 0 }, rules: [{ id: 'r1', on: 'btn1.clicked', do: [{ cmd: 'level.next' }] }] },
        questions: [{ id: 'q1', data: { a: 1 }, scoring: { max: 10 } }],
      },
    } as never)
    const c = await renderHome()
    expect(c.textContent).toContain('旧版关卡')
    expect(c.textContent).toContain('1 个组件 · 1 道题')
    // 内置 v3 关卡（教程）同屏正常
    expect(c.textContent).toContain('新手引导 · 交互教程')
  })

  it('毒数据（迁移器拒绝的文档）：卡片降级展示，不拖垮整页', async () => {
    await putResource({
      id: 'res_01J9D100000000000000000000',
      kind: 'level',
      version: '1.0.0',
      meta: { title: '损坏关卡' },
      content: { components: [], logic: { logicVersion: 2, variables: {}, nodes: [], edges: [] }, table: { columns: [], rows: [] } },
      schemaVersion: 3,
      kind2: 'oops', // 字段无害——用 kind 缺失构造迁移失败：覆盖 kind 为非法值
    } as never)
    // 直接改库里的 doc.kind 为非法值（绕过 putResource 的信封取值）
    await db.resources.update('res_01J9D100000000000000000000', (rec) => {
      ;(rec.doc as { kind: string }).kind = 'not-a-kind'
    })
    const c = await renderHome()
    expect(c.textContent).toContain('损坏关卡')
    expect(c.textContent).toContain('文档格式无法解析')
    // 其余卡片不受影响
    expect(c.textContent).toContain('新手引导 · 交互教程')
  })
})
