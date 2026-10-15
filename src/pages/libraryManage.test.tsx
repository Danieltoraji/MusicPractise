// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, putResource } from '../library/db'
import { LibraryPage } from './LibraryPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const containers: HTMLElement[] = []
const roots: Root[] = []

function renderEl(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  containers.push(container)
  roots.push(root)
  return container
}

async function flushUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil 超时')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

function seriesDoc(id: string, title: string, topicIds: string[]): unknown {
  return { schemaVersion: 1, kind: 'series', id, version: '1.0.0', meta: { title }, refs: [], content: { topicIds } }
}

function topicDoc(id: string, title: string, levelIds: string[] = []): unknown {
  return { schemaVersion: 1, kind: 'topic', id, version: '1.0.0', meta: { title }, refs: [], content: { levelIds, brief: '' } }
}

function levelDoc(id: string, title: string): unknown {
  return { schemaVersion: 3, kind: 'level', id, version: '1.0.0', meta: { title }, refs: [], content: { views: [], components: [] } }
}

/** 种子：系列 S(ser_s) ▸ 专题 T(top_t) + 散关卡 L(lvl_l) */
async function seedTree(): Promise<void> {
  await putResource(seriesDoc('ser_s', '系列甲', ['top_t']) as never)
  await putResource(topicDoc('top_t', '专题乙') as never)
  await putResource(levelDoc('lvl_l', '关卡丙') as never)
}

function findRow(c: HTMLElement, title: string): HTMLElement {
  const row = [...c.querySelectorAll('.lib-row')].find((r) => r.textContent?.includes(title))
  if (!row) throw new Error(`找不到行：${title}`)
  return row as HTMLElement
}

function rowButton(row: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...row.querySelectorAll('.row-actions button')].find((b) => b.textContent?.includes(text))
  if (!btn) throw new Error(`找不到按钮：${text}`)
  return btn as HTMLButtonElement
}

beforeEach(async () => {
  window.location.hash = ''
  sessionStorage.clear()
  await db.resources.clear()
  await db.progress.clear()
})

afterEach(async () => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  vi.restoreAllMocks()
  await db.resources.clear()
})

describe('LibraryPage 文件管理器操作（docs/39 H1）', () => {
  it('新建系列：prompt 输入名称 → 入库并出现在系列区', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('我的新系列')
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.querySelector('.page-actions') !== null)
    act(() => [...c.querySelectorAll('button')].find((b) => b.textContent?.includes('新建系列'))!.click())
    await flushUntil(() => c.textContent?.includes('我的新系列') === true)
    const recs = await db.resources.where('kind').equals('series').toArray()
    expect(recs).toHaveLength(1)
    expect(recs[0].title).toBe('我的新系列')
  })

  it('新建系列空名称：报错不入库', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('   ')
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.querySelector('.page-actions') !== null)
    act(() => [...c.querySelectorAll('button')].find((b) => b.textContent?.includes('新建系列'))!.click())
    await flushUntil(() => c.textContent?.includes('名称不能为空') === true)
    expect(await db.resources.where('kind').equals('series').count()).toBe(0)
  })

  it('系列行「新建专题」：专题入库并挂到系列 topicIds', async () => {
    await seedTree()
    vi.spyOn(window, 'prompt').mockReturnValue('新专题')
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.textContent?.includes('系列甲') === true)
    act(() => rowButton(findRow(c, '系列甲'), '新建专题').click())
    // 折叠的系列行以「N 个专题」计数反映新增
    await flushUntil(() => c.textContent?.includes('2 个专题') === true)
    const series = await db.resources.get('ser_s')
    const topics = await db.resources.where('kind').equals('topic').toArray()
    expect(topics).toHaveLength(2)
    const created = topics.find((t) => t.id !== 'top_t')!
    expect(created.title).toBe('新专题')
    expect((series!.doc as { content: { topicIds: string[] } }).content.topicIds).toContain(created.id)
  })

  it('移动关卡到专题：单亲语义写入 topic.levelIds，关卡离开未整理区', async () => {
    await seedTree()
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.textContent?.includes('关卡丙') === true)
    act(() => rowButton(findRow(c, '关卡丙'), '移动…').click())
    await flushUntil(() => c.querySelector('.tjson-backdrop') !== null)
    const target = [...c.querySelectorAll('.lib-move-target')].find((b) => b.textContent?.includes('专题乙')) as HTMLButtonElement
    expect(target.disabled).toBe(false)
    // 未整理选项当前不可选（关卡尚无父容器）
    const loose = [...c.querySelectorAll('.lib-move-target')].find((b) => b.textContent?.includes('未整理')) as HTMLButtonElement
    expect(loose.disabled).toBe(true)
    act(() => target.click())
    // 弹窗关闭（移动完成后自动收起），库中专题已挂上关卡
    await flushUntil(() => c.querySelector('.tjson-backdrop') === null)
    const topic = await db.resources.get('top_t')
    expect((topic!.doc as { content: { levelIds: string[] } }).content.levelIds).toEqual(['lvl_l'])
  })

  it('复制关卡到未整理：新 id（副本），不挂任何专题', async () => {
    await seedTree()
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.textContent?.includes('关卡丙') === true)
    act(() => rowButton(findRow(c, '关卡丙'), '复制…').click())
    await flushUntil(() => c.querySelector('.tjson-backdrop') !== null)
    const loose = [...c.querySelectorAll('.lib-move-target')].find((b) => b.textContent?.includes('未整理')) as HTMLButtonElement
    expect(loose.disabled).toBe(false) // 复制模式不受当前位置限制
    act(() => loose.click())
    await flushUntil(() => c.textContent?.includes('关卡丙（副本）') === true)
    const recs = await db.resources.where('kind').equals('level').toArray()
    expect(recs).toHaveLength(2)
    const copy = recs.find((r) => r.id !== 'lvl_l')!
    expect(copy.title).toBe('关卡丙（副本）')
    const topic = await db.resources.get('top_t')
    expect((topic!.doc as { content: { levelIds: string[] } }).content.levelIds).toEqual([])
  })

  it('复制系列：confirm 展示规模，整树新 id 副本，原系列不动', async () => {
    await putResource(seriesDoc('ser_s', '系列甲', ['top_t']) as never)
    await putResource(topicDoc('top_t', '专题乙', ['lvl_l']) as never)
    await putResource(levelDoc('lvl_l', '关卡丙') as never)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.textContent?.includes('系列甲') === true)
    act(() => rowButton(findRow(c, '系列甲'), '复制').click())
    await flushUntil(() => c.textContent?.includes('系列甲（副本）') === true)
    expect(window.confirm).toHaveBeenCalledTimes(1)
    const seriesRecs = await db.resources.where('kind').equals('series').toArray()
    expect(seriesRecs).toHaveLength(2)
    const copy = seriesRecs.find((s) => s.id !== 'ser_s')!
    expect(copy.title).toBe('系列甲（副本）')
    const topics = await db.resources.where('kind').equals('topic').toArray()
    const levels = await db.resources.where('kind').equals('level').toArray()
    expect(topics).toHaveLength(2)
    expect(levels).toHaveLength(2)
    const original = await db.resources.get('ser_s')
    expect((original!.doc as { content: { topicIds: string[] } }).content.topicIds).toEqual(['top_t'])
  })

  it('重命名专题：更新 meta.title', async () => {
    await seedTree()
    vi.spyOn(window, 'prompt').mockReturnValue('专题改名')
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.textContent?.includes('系列甲') === true)
    // 展开系列后找到专题行
    act(() => {
      const twist = findRow(c, '系列甲').querySelector('.lib-twist') as HTMLButtonElement
      twist.click()
    })
    await flushUntil(() => c.textContent?.includes('专题乙') === true)
    act(() => rowButton(findRow(c, '专题乙'), '重命名').click())
    await flushUntil(() => c.textContent?.includes('专题改名') === true)
    const topic = await db.resources.get('top_t')
    expect((topic!.doc as { meta: { title: string } }).meta.title).toBe('专题改名')
    expect(topic!.title).toBe('专题改名')
  })

  it('删除系列：容器消失，专题与关卡回落未整理', async () => {
    await seedTree()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.textContent?.includes('系列甲') === true)
    act(() => rowButton(findRow(c, '系列甲'), '删除').click())
    await flushUntil(() => c.textContent?.includes('系列甲') !== true)
    expect(await db.resources.get('ser_s')).toBeUndefined()
    expect(await db.resources.get('top_t')).toBeDefined()
    expect(await db.resources.get('lvl_l')).toBeDefined()
  })

  it('内置资源只读：无重命名/删除按钮、新建专题禁用、移动对话框内置容器禁选', async () => {
    await putResource(seriesDoc('ser_bi', '内置系列', ['top_bi']) as never, true)
    await putResource(topicDoc('top_bi', '内置专题') as never, true)
    await putResource(levelDoc('lvl_l', '关卡丙') as never)
    const c = renderEl(<LibraryPage />)
    await flushUntil(() => c.textContent?.includes('内置系列') === true)
    const biRow = findRow(c, '内置系列')
    expect(rowButton(biRow, '新建专题').disabled).toBe(true)
    expect([...biRow.querySelectorAll('.row-actions button')].some((b) => b.textContent === '重命名')).toBe(false)
    expect([...biRow.querySelectorAll('.row-actions button')].some((b) => b.textContent === '删除')).toBe(false)
    // 用户关卡的移动目标中，内置专题（及其所属内置系列）禁选
    act(() => rowButton(findRow(c, '关卡丙'), '移动…').click())
    await flushUntil(() => c.querySelector('.tjson-backdrop') !== null)
    const target = [...c.querySelectorAll('.lib-move-target')].find((b) => b.textContent?.includes('内置专题')) as HTMLButtonElement
    expect(target.disabled).toBe(true)
    expect(target.title).toContain('内置')
  })
})
