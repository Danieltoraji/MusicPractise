// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { LibraryRecord } from './db'
import { organizedLevelIds, partitionLevels } from './browse'

const rec = (id: string, kind: 'level' | 'topic', levelIds?: string[]): LibraryRecord => ({
  id,
  kind,
  version: '1.0.0',
  title: id,
  doc: {
    id,
    kind,
    content: levelIds ? { levelIds } : {},
  },
  importedAt: 0,
  builtIn: 1,
})

describe('浏览分区', () => {
  const topics = [rec('t1', 'topic', ['l1', 'l2']), rec('t2', 'topic', ['l3'])]
  const levels = [rec('l1', 'level'), rec('l2', 'level'), rec('l3', 'level'), rec('l4', 'level')]

  it('organizedLevelIds 收集所有专题引用的关卡', () => {
    expect(organizedLevelIds(topics)).toEqual(new Set(['l1', 'l2', 'l3']))
  })

  it('partitionLevels：被引用的进 organized，其余为独立关卡', () => {
    const { organized, independent } = partitionLevels(levels, topics)
    expect(organized.map((l) => l.id)).toEqual(['l1', 'l2', 'l3'])
    expect(independent.map((l) => l.id)).toEqual(['l4'])
  })

  it('无专题时全部关卡都是独立的', () => {
    const { organized, independent } = partitionLevels(levels, [])
    expect(organized).toHaveLength(0)
    expect(independent).toHaveLength(4)
  })
})
