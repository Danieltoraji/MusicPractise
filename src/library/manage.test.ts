import { describe, expect, it } from 'vitest'
import { validateEnvelope } from './validate'
import {
  appendRefId,
  blankSeriesDoc,
  blankTopicDoc,
  copyLevelDoc,
  copySeriesTree,
  moveLevelIntoTopic,
  moveTopicIntoSeries,
  renameDoc,
  type ContainerDoc,
  type LevelLike,
  type SeriesDoc,
  type TopicDoc,
} from './manage'

function makeSeries(id: string, title: string, topicIds: string[] = []): SeriesDoc {
  return {
    schemaVersion: 1,
    kind: 'series',
    id,
    version: '1.0.0',
    meta: { title },
    refs: [],
    content: { topicIds },
  }
}

function makeTopic(id: string, title: string, levelIds: string[] = []): TopicDoc {
  return {
    schemaVersion: 1,
    kind: 'topic',
    id,
    version: '1.0.0',
    meta: { title },
    refs: [],
    content: { levelIds, brief: '' },
  }
}

function makeLevel(id: string, title: string): LevelLike {
  return {
    schemaVersion: 3,
    kind: 'level',
    id,
    version: '1.0.0',
    meta: { title },
    refs: [],
    content: { views: [], components: [] },
  }
}

describe('文档工厂', () => {
  it('空白系列/专题通过信封校验，id 形态合法', () => {
    const series = blankSeriesDoc('我的系列')
    const topic = blankTopicDoc('我的专题')
    expect(validateEnvelope('series', series).ok).toBe(true)
    expect(validateEnvelope('topic', topic).ok).toBe(true)
    expect(series.id).toMatch(/^res_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(topic.id).toMatch(/^res_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(series.content.topicIds).toEqual([])
    expect(topic.content.levelIds).toEqual([])
  })

  it('同 id 概率为零（新 id 各自独立生成）', () => {
    expect(blankSeriesDoc().id).not.toBe(blankSeriesDoc().id)
  })
})

describe('renameDoc', () => {
  it('NFC + trim，不改原对象', () => {
    const topic = makeTopic('t1', '旧名')
    const next = renameDoc(topic, '  新名  ')
    expect(next.meta.title).toBe('新名')
    expect(topic.meta.title).toBe('旧名')
    expect(next).not.toBe(topic)
  })

  it('空标题原样返回（同一引用）', () => {
    const topic = makeTopic('t1', '旧名')
    expect(renameDoc(topic, '   ')).toBe(topic)
  })
})

describe('appendRefId / moveLevelIntoTopic / moveTopicIntoSeries', () => {
  it('appendRefId：追加并去重，重复追加返回原引用', () => {
    const topic = makeTopic('t1', '专题')
    const next = appendRefId(topic, 'levelIds', 'l1')
    expect(next.content.levelIds).toEqual(['l1'])
    expect(appendRefId(next, 'levelIds', 'l1')).toBe(next)
  })

  it('移动关卡：旧专题移除、新专题追加、无关专题保持原引用', () => {
    const a = makeTopic('a', 'A', ['l1'])
    const b = makeTopic('b', 'B')
    const c = makeTopic('c', 'C')
    const next = moveLevelIntoTopic('l1', 'b', [a, b, c])
    expect(next[0].content.levelIds).toEqual([])
    expect(next[1].content.levelIds).toEqual(['l1'])
    expect(next[2]).toBe(c)
  })

  it('移动到 null：从所有专题移除（多亲收敛为未整理）', () => {
    const a = makeTopic('a', 'A', ['l1'])
    const b = makeTopic('b', 'B', ['l1', 'l2'])
    const next = moveLevelIntoTopic('l1', null, [a, b])
    expect(next[0].content.levelIds).toEqual([])
    expect(next[1].content.levelIds).toEqual(['l2'])
  })

  it('已在目标专题：全部原样返回（无变更无克隆）', () => {
    const a = makeTopic('a', 'A', ['l1'])
    const next = moveLevelIntoTopic('l1', 'a', [a])
    expect(next[0]).toBe(a)
  })

  it('多亲关卡移动到新专题：所有旧引用移除，单亲达成', () => {
    const a = makeTopic('a', 'A', ['l1'])
    const b = makeTopic('b', 'B', ['l1'])
    const c = makeTopic('c', 'C')
    const next = moveLevelIntoTopic('l1', 'c', [a, b, c])
    expect(next[0].content.levelIds).toEqual([])
    expect(next[1].content.levelIds).toEqual([])
    expect(next[2].content.levelIds).toEqual(['l1'])
  })

  it('移动专题到系列：对称语义', () => {
    const s1 = makeSeries('s1', '系列一', ['t1'])
    const s2 = makeSeries('s2', '系列二')
    const next = moveTopicIntoSeries('t1', 's2', [s1, s2])
    expect(next[0].content.topicIds).toEqual([])
    expect(next[1].content.topicIds).toEqual(['t1'])
    expect(
      moveTopicIntoSeries('t1', null, [s1, s2]).every((s) => (s.content as { topicIds: string[] }).topicIds.length === 0),
    ).toBe(true)
  })
})

describe('copyLevelDoc', () => {
  it('新 id、标题加（副本）、内容深拷贝、原对象不动', () => {
    const level = makeLevel('l1', '音阶练习')
    const copy = copyLevelDoc(level)
    expect(copy.id).not.toBe('l1')
    expect(copy.id).toMatch(/^res_/)
    expect(copy.meta.title).toBe('音阶练习（副本）')
    expect(copy.content).toEqual(level.content)
    expect(copy.content).not.toBe(level.content)
    expect(level.id).toBe('l1')
    expect(level.meta.title).toBe('音阶练习')
  })

  it('已有（副本）后缀不重复', () => {
    const copy = copyLevelDoc(makeLevel('l1', '音阶练习（副本）'))
    expect(copy.meta.title).toBe('音阶练习（副本）')
  })
})

describe('copySeriesTree', () => {
  it('整树重发 id 并重写引用；共享关卡只复制一份；仅根标题加后缀', () => {
    const series = makeSeries('s0', '入门系列', ['t1', 't2'])
    const t1 = makeTopic('t1', '专题一', ['l1', 'l2'])
    const t2 = makeTopic('t2', '专题二', ['l1'])
    const l1 = makeLevel('l1', '共享关')
    const l2 = makeLevel('l2', '专属关')
    const tree = copySeriesTree(series, [t1, t2], [l1, l2])

    expect(tree.series.id).not.toBe('s0')
    expect(tree.series.meta.title).toBe('入门系列（副本）')
    expect(tree.topics.every((t) => !String(t.meta.title).includes('（副本）'))).toBe(true)
    expect(tree.topics[0].meta.title).toBe('专题一')
    expect(tree.topics[1].meta.title).toBe('专题二')

    // topicIds 重映射，顺序保持
    expect(tree.series.content.topicIds).toHaveLength(2)
    expect(tree.series.content.topicIds).not.toContain('t1')
    expect(tree.series.content.topicIds).not.toContain('t2')
    // 两个旧专题 id 各映射到不同新 id
    const [nt1, nt2] = tree.series.content.topicIds
    expect(new Set(tree.series.content.topicIds).size).toBe(2)

    // levelIds 重映射；共享关卡 l1 在两个新专题中指向同一新副本
    const nt1Doc = tree.topics.find((t) => t.id === nt1)!
    const nt2Doc = tree.topics.find((t) => t.id === nt2)!
    expect(nt1Doc.content.levelIds).toHaveLength(2)
    expect(nt2Doc.content.levelIds).toHaveLength(1)
    expect(nt2Doc.content.levelIds[0]).toBe(nt1Doc.content.levelIds[0])
    expect(tree.levels).toHaveLength(2) // l1 复制一份 + l2 一份

    // 新副本 id 均不同于旧 id
    for (const l of tree.levels) expect(['l1', 'l2']).not.toContain(l.id)
  })

  it('缺件引用 id 原样保留；输入对象不被修改', () => {
    const series = makeSeries('s0', '系列', ['t1'])
    const t1 = makeTopic('t1', '专题', ['l1', 'ghost'])
    const l1 = makeLevel('l1', '关卡')
    const tree = copySeriesTree(series, [t1], [l1])
    const nt1 = tree.topics[0]
    expect(nt1.content.levelIds).toContain('ghost')
    expect(nt1.content.levelIds).not.toContain('l1')
    // 输入不动
    expect(series.content.topicIds).toEqual(['t1'])
    expect(t1.content.levelIds).toEqual(['l1', 'ghost'])
    expect(l1.id).toBe('l1')
  })
})

describe('类型兼容（编译期守卫）', () => {
  it('ContainerDoc 视图可接受系列/专题文档', () => {
    const docs: ContainerDoc[] = [makeSeries('s1', 'x'), makeTopic('t1', 'y')]
    expect(docs).toHaveLength(2)
  })
})
