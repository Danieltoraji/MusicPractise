// @vitest-environment jsdom
/**
 * 零代码模板入口（W8.2）：`#/edit/new` 首帧展示模板选择条，选定后生成普通 LevelDocV4
 * （题型/实例表/流程骨架），条消失、可继续用既有 Tab 编辑；也可空白开始。
 */
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEVEL_TEMPLATES } from '../../engine/v4/templates'
import { db } from '../../library/db'
import { EditorPageV4 } from './EditorPageV4'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement | null = null

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
  }
  throw new Error(`等待超时：${label}`)
}

beforeEach(async () => {
  await db.resources.clear()
  await db.progress.clear()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
})

async function renderNewEditor(): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root!.render(<EditorPageV4 id="new" />)
  })
  await waitFor(() => container!.querySelector('[data-testid="v4-editor"]') !== null, 'v4 编辑器挂载')
  return container
}

describe('v4 零代码模板入口（#/edit/new）', () => {
  it('默认展示模板选择条；选「听音选择」→ 生成普通文档（标题/实例表/流程齐备）且条消失', async () => {
    const el = await renderNewEditor()
    expect(el.querySelector('[data-testid="v4-template-start"]')).not.toBeNull()
    for (const template of LEVEL_TEMPLATES) {
      expect(el.querySelector(`[data-testid="v4-template-${template.id}"]`)).not.toBeNull()
    }

    const pick = el.querySelector('[data-testid="v4-template-listen-choice"]') as HTMLButtonElement
    await act(async () => {
      pick.click()
    })
    await waitFor(() => container!.querySelector('[data-testid="v4-template-start"]') === null, '模板条消失')

    const expectedTitle = LEVEL_TEMPLATES.find((template) => template.id === 'listen-choice')!.create().meta.title
    const titleInput = el.querySelector('[data-testid="editor-title"]') as HTMLInputElement
    expect(titleInput.value).toBe(expectedTitle)
    expect(el.querySelector('[data-testid="v4-tgrid-add-row"]')).not.toBeNull()
    // 内容表里存在至少一行模板数据
    expect(el.querySelector('[data-testid^="v4-tgrid-row-"]')).not.toBeNull()
  })

  it('「直接空白开始」跳过模板，条消失且编辑器仍可用', async () => {
    const el = await renderNewEditor()
    const skip = el.querySelector('[data-testid="v4-template-skip"]') as HTMLButtonElement
    await act(async () => {
      skip.click()
    })
    await waitFor(() => container!.querySelector('[data-testid="v4-template-start"]') === null, '模板条消失')
    // 空白 v4 文档允许从零加题型：内容 Tab 在位、无装载错误
    expect(el.querySelector('[data-testid="v4-content-tab"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="v4-editor"]')).not.toBeNull()
  })
})
