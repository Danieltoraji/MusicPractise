// 资源库树构建与过滤：系列=文件夹 → 专题 → 关卡；未引用资源归「未整理」
import { describe, expect, it } from 'vitest'
import type { LibraryRecord, ResourceKind } from './db'
import { buildLibraryTree, filterTree } from './browse'

function rec(id: string, kind: ResourceKind, title: string, childIds?: { key: 'topicIds' | 'levelIds'; ids: string[] }): LibraryRecord {
  return {
    id,
    kind,
    version: '1.0.0',
    title,
    importedAt: 0,
    builtIn: 0,
    doc: {
      id,
      kind,
      content: childIds ? { [childIds.key]: childIds.ids } : {},
    },
  } as unknown as LibraryRecord
}

const S = (id: string, title: string, topicIds: string[]) => rec(id, 'series', title, { key: 'topicIds', ids: topicIds })
const T = (id: string, title: string, levelIds: string[]) => rec(id, 'topic', title, { key: 'levelIds', ids: levelIds })
const L = (id: string, title: string) => rec(id, 'level', title)

describe('buildLibraryTree', () => {
  it('系列 → 专题 → 关卡 三层归组；未被引用的资源进未整理区', () => {
    const { series, loose } = buildLibraryTree([
      L('lv1', '关卡一'),
      T('tp1', '专题一', ['lv1', 'lv2']),
      S('se1', '系列一', ['tp1']),
      L('lv2', '关卡二'),
      L('lv3', '独立关卡'),
      rec('in1', 'instrument', '吉他'),
    ])
    expect(series).toHaveLength(1)
    expect(series[0].rec.id).toBe('se1')
    expect(series[0].children?.map((c) => c.rec.id)).toEqual(['tp1'])
    expect(series[0].children?.[0].children?.map((c) => c.rec.id)).toEqual(['lv1', 'lv2'])
    // 未整理：独立关卡 + 乐器；lv1/lv2 已被专题引用、tp1 已被系列引用
    expect(loose.map((r) => r.rec.id)).toEqual(['lv3', 'in1'])
    expect(loose.find((r) => r.rec.id === 'in1')?.children).toBeUndefined()
  })

  it('同一关卡被两个专题引用：只出现在未整理区一次（不重复）', () => {
    const { loose } = buildLibraryTree([
      T('tpA', '专题A', ['lvX']),
      S('se1', '系列一', ['tpA']),
      T('tpB', '专题B', ['lvX']),
      L('lvX', '共享关卡'),
    ])
    expect(loose.map((r) => r.rec.id)).toEqual(['tpB'])
  })

  it('引用缺失的子 id 跳过；专题无子级时 children 为空数组', () => {
    const { series } = buildLibraryTree([
      S('se1', '系列一', ['tpGhost', 'tp1']),
      T('tp1', '专题一', ['lvGhost']),
      L('lv1', '关卡一'),
    ])
    const topics = series[0].children ?? []
    expect(topics.map((t) => t.rec.id)).toEqual(['tp1'])
    expect(topics[0].children).toEqual([])
  })

  it('确定性：同输入同输出', () => {
    const res = [S('se1', '系列', ['tp1']), T('tp1', '专题', ['lv1']), L('lv1', '关卡')]
    expect(buildLibraryTree(res)).toEqual(buildLibraryTree([...res].reverse()))
  })
})

describe('filterTree', () => {
  const rows = buildLibraryTree([
    L('lv1', '听音点击'),
    T('tp1', '听音专题', ['lv1']),
    S('se1', '入门系列', ['tp1']),
    L('lv2', '节奏训练'),
  ]).series

  it('命中叶子：保留祖先路径（文件夹自动打开）', () => {
    const hit = filterTree(rows, '听音点击')
    expect(hit).toHaveLength(1)
    expect(hit[0].rec.id).toBe('se1')
    expect(hit[0].children?.[0].rec.id).toBe('tp1')
    expect(hit[0].children?.[0].children?.map((c) => c.rec.id)).toEqual(['lv1'])
  })

  it('命中文件夹：整棵子树保留', () => {
    const hit = filterTree(rows, '入门')
    expect(hit[0].children?.[0].children?.map((c) => c.rec.id)).toEqual(['lv1'])
  })

  it('无命中返回空；空关键词原样返回', () => {
    expect(filterTree(rows, '不存在')).toEqual([])
    expect(filterTree(rows, '')).toBe(rows)
  })
})

describe('评审修复回归（docs/23）', () => {
  it('循环引用（专题自指/两专题互指）被深度截断，不栈溢出', () => {
    const res = [
      S('se1', '系列', ['tp1']),
      T('tp1', '自指专题', ['tp1']),
      T('tp2', '互指A', ['tp3']),
      T('tp3', '互指B', ['tp2']),
      L('lv1', '关卡'),
    ]
    expect(() => buildLibraryTree(res)).not.toThrow()
    const { series, loose } = buildLibraryTree(res)
    // 自指专题：按树语义深度截断（系列0→专题1→专题2→空），有限行数而非无限展开
    const selfRef = series[0].children![0]
    expect(selfRef.children![0].rec.id).toBe('tp1')
    expect(selfRef.children![0].children![0].children).toEqual([])
    // lv1 是未被引用的独立关卡，同属未整理区
    expect(loose.map((r) => r.rec.id).sort()).toEqual(['lv1', 'tp2', 'tp3'])
  })

  it('重复子引用去重（React key 不冲突、计数不虚高）', () => {
    const { series } = buildLibraryTree([
      S('se1', '系列', ['tp1', 'tp1']),
      T('tp1', '专题', ['lv1', 'lv1']),
      L('lv1', '关卡'),
    ])
    const topics = series[0].children ?? []
    expect(topics).toHaveLength(1)
    expect(topics[0].children).toHaveLength(1)
  })

  it('filterTree 大小写不敏感', () => {
    const { loose } = buildLibraryTree([L('lv1', 'Rhythm Trainer')])
    expect(filterTree(loose, 'rhythm')).toHaveLength(1)
    expect(filterTree(loose, 'RHYTHM')).toHaveLength(1)
  })

  it('partitionLevels / organizedLevelIds（HomePage 存活代码回归）', async () => {
    const { partitionLevels, organizedLevelIds } = await import('./browse')
    const topics = [T('tp1', '专题', ['lvA'])]
    const levels = [L('lvA', 'A'), L('lvB', 'B')]
    expect(organizedLevelIds(topics)).toEqual(new Set(['lvA']))
    const { organized, independent } = partitionLevels(levels, topics)
    expect(organized.map((r) => r.id)).toEqual(['lvA'])
    expect(independent.map((r) => r.id)).toEqual(['lvB'])
  })
})
