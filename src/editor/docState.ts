/**
 * 编辑器的文档状态操作：不可变更新 + 空白/副本模板。
 * 编辑态是内存中的 LevelDoc 副本，保存时经 loadLevelDoc 校验后入库。
 */
import type { LevelDoc, ComponentInstance, Question } from '../engine/level'
import type { Json } from '../engine/expr'
import { newResourceId } from '../library/id'

export function blankLevelDoc(): LevelDoc {
  return {
    schemaVersion: 1,
    kind: 'level',
    id: newResourceId(),
    version: '0.1.0',
    meta: {
      title: '未命名关卡',
      description: '',
      author: { name: '' },
      tags: [],
      locale: 'zh-CN',
      license: 'CC0-1.0',
      difficulty: 1,
    },
    refs: [],
    content: {
      components: [],
      logic: {
        variables: { score: 0 },
        rules: [
          {
            id: 'score-on-correct',
            on: 'level:correct',
            do: [{ set: 'score', expr: 'v.score + 10' }],
          },
        ],
      },
      questions: [{ id: 'q1', data: {}, scoring: { max: 10 } }],
      flow: { order: 'sequential', pass: { expr: 'v.score >= 10' } },
    },
  }
}

/** 以库内文档为底稿创建编辑副本：新 id、版本归零、标题加后缀 */
export function copyForEditing(doc: LevelDoc): LevelDoc {
  const copy = structuredClone(doc) as LevelDoc
  copy.id = newResourceId()
  copy.version = '0.1.0'
  copy.meta = { ...copy.meta, title: `${String(copy.meta.title ?? '')}（副本）` }
  return copy
}

/** 组件实例默认布局：按顺序纵向排列，避免全部叠在原点 */
export function defaultLayout(index: number): { x: number; y: number; w: number; h: number } {
  return { x: 40 + (index % 3) * 240, y: 40 + Math.floor(index / 3) * 120, w: 200, h: 60 }
}

export function addComponent(doc: LevelDoc, type: string): LevelDoc {
  const next = structuredClone(doc)
  const used = new Set(next.content.components.map((c) => c.id))
  let n = 1
  while (used.has(`${type}${n}`)) n++
  const comp: ComponentInstance = { id: `${type}${n}`, type, visible: true, layout: defaultLayout(next.content.components.length) }
  next.content.components.push(comp)
  return next
}

export function updateComponent(doc: LevelDoc, cid: string, patch: Partial<ComponentInstance>): LevelDoc {
  const next = structuredClone(doc)
  const comp = next.content.components.find((c) => c.id === cid)
  if (comp) Object.assign(comp, patch)
  return next
}

export function removeComponent(doc: LevelDoc, cid: string): LevelDoc {
  const next = structuredClone(doc)
  next.content.components = next.content.components.filter((c) => c.id !== cid)
  return next
}

export function updateQuestion(doc: LevelDoc, index: number, patch: Partial<Question>): LevelDoc {
  const next = structuredClone(doc)
  const q = next.content.questions[index]
  if (q) Object.assign(q, patch)
  return next
}

export function setMeta(doc: LevelDoc, patch: Partial<LevelDoc['meta']>): LevelDoc {
  const next = structuredClone(doc)
  Object.assign(next.meta, patch)
  return next
}

// ---------------------------------------------------------------------------
// 变量管理（RulesEditor 变量表用）
// ---------------------------------------------------------------------------

/** 值解析启发式：true/false → 布尔、可解析数字 → number、其余字符串 */
export function parseScalarInput(text: string): number | boolean | string {
  const t = text.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t)
  return text
}

export function setVariable(doc: LevelDoc, name: string, value: number | boolean | string): LevelDoc {
  const next = structuredClone(doc)
  next.content.logic.variables = { ...(next.content.logic.variables ?? {}), [name]: value }
  return next
}

export function renameVariable(doc: LevelDoc, oldName: string, newName: string): LevelDoc {
  const next = structuredClone(doc)
  const vars = { ...(next.content.logic.variables ?? {}) }
  if (oldName in vars) {
    vars[newName] = vars[oldName]
    delete vars[oldName]
  }
  next.content.logic.variables = vars
  return next
}

export function removeVariable(doc: LevelDoc, name: string): LevelDoc {
  const next = structuredClone(doc)
  const vars = { ...(next.content.logic.variables ?? {}) }
  delete vars[name]
  next.content.logic.variables = vars
  return next
}

/** 解析 JSON 文本；失败返回 null（调用方显示错误） */
export function parseJsonText(text: string): Json | null {
  try {
    const v = JSON.parse(text)
    return v === null ? null : (v as Json)
  } catch {
    return null
  }
}
