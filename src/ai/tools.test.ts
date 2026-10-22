// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { addComponent, blankLevelDoc, setTable } from '../editor/docState'
import type { LevelDoc } from '../engine/level'
import { clearRunLog, appendRunLog } from '../runtime/runLog'
import { READONLY_TOOLS, type ToolContext } from './tools'

function makeDoc(): LevelDoc {
  let doc = blankLevelDoc()
  doc = setTable(doc, {
    columns: [
      { key: 'title', label: '题面', type: 'text' },
      { key: 'scoring', label: '分值', type: 'number' },
    ],
    rows: Array.from({ length: 15 }, (_, i) => ({ title: `第${i + 1}题`, scoring: 10 })),
  })
  doc = addComponent(doc, 'button', 'main')
  doc = addComponent(doc, 'sound', 'main')
  // 改写逻辑：一个最小的合法事件处理器（保留 blank 的变量）
  doc = {
    ...doc,
    content: {
      ...doc.content,
      logic: {
        logicVersion: 2,
        variables: { score: 0 },
        nodes: [
          { id: 'on1', kind: 'on', event: 'button1.clicked' },
          { id: 'c1', kind: 'call', target: 'sound1', method: 'play', args: [] },
        ],
        edges: [{ id: 'e1', from: 'on1', to: 'c1' }],
      },
    },
  } as LevelDoc
  return doc
}

const ctxFor = (doc: LevelDoc): ToolContext => ({ getDoc: () => doc, applyDoc: () => {}, levelId: doc.id })

function tool(name: string) {
  const t = READONLY_TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`没有工具 ${name}`)
  return t
}

beforeEach(() => {
  clearRunLog('res_t')
})

describe('AI 只读工具', () => {
  it('read_script：伪代码与图同文；非结构化图降级节点清单', () => {
    const doc = makeDoc()
    const text = tool('read_script').exec({}, ctxFor(doc)) as string
    expect(text).toContain('on button1.clicked {')
    expect(text).toContain('sound1.play()')
    // 非结构化（多路径汇入）→ 降级列出节点
    const bad = {
      ...doc,
      content: {
        ...doc.content,
        logic: {
          logicVersion: 2,
          variables: {},
          nodes: [
            { id: 'on1', kind: 'on', event: 'a.a' },
            { id: 'br', kind: 'branch', cond: 'v.go' },
            { id: 'x1', kind: 'call', target: 's', method: 'stop', args: [] },
            { id: 'x2', kind: 'call', target: 's', method: 'stop', args: [] },
            { id: 'z', kind: 'assign', target: 'q', value: { expr: '1' } },
          ],
          edges: [
            { id: 'e1', from: 'on1', to: 'br' },
            { id: 'e2', from: 'br', to: 'x1', port: 'true' },
            { id: 'e3', from: 'br', to: 'x2', port: 'false' },
            { id: 'e4', from: 'x1', to: 'z' },
            { id: 'e5', from: 'x2', to: 'z' },
            { id: 'e6', from: 'z', to: 'x1' },
          ],
        },
      },
    } as unknown as LevelDoc
    const fallback = tool('read_script').exec({}, ctxFor(bad)) as string
    expect(fallback).toContain('超出伪代码')
    expect(fallback).toContain('- br: if (v.go)')
  })

  it('read_doc：分节输出；行数超限截断并注明', () => {
    const doc = makeDoc()
    const table = tool('read_doc').exec({ part: 'table' }, ctxFor(doc)) as string
    expect(table).toContain('"title"')
    expect(table).toContain('共 15 行')
    expect(table).toContain('仅显示前 10 行')
    expect(table).not.toContain('第15题')
    const all = tool('read_doc').exec({}, ctxFor(doc)) as string
    expect(all).toContain('## components')
    expect(all).toContain('button1')
    expect(all).toContain('## logic 概要')
  })

  it('read_doc：组件段附事件/命令契约清单（写入逻辑前的事件名依据）', () => {
    const doc = makeDoc()
    const comps = tool('read_doc').exec({ part: 'components' }, ctxFor(doc)) as string
    expect(comps).toContain('"events"')
    expect(comps).toContain('"commands"')
    // button 契约：clicked 事件 / setText、setEnabled 命令（F3：下发「键(负载说明)」值形态）
    expect(comps).toContain('clicked(')
    expect(comps).toContain('setText(')
    expect(comps).toContain('setEnabled(')
  })

  it('read_json：完整 JSON', () => {
    const doc = makeDoc()
    const text = tool('read_json').exec({}, ctxFor(doc)) as string
    expect(text).toContain('"logicVersion": 2')
    expect(text).toContain('"scoring"')
  })

  it('lint：合法文档通过；坏引用被点名', () => {
    const doc = makeDoc()
    const ok = tool('lint').exec({}, ctxFor(doc)) as string
    expect(ok).toContain('装载校验通过')
    expect(ok).toContain('图 lint】无问题')
    const bad = {
      ...doc,
      content: {
        ...doc.content,
        logic: {
          ...doc.content.logic,
          nodes: [
            ...(doc.content.logic.nodes as { id: string; kind: string; target?: string; method?: string; args?: string[] }[]),
            { id: 'bad1', kind: 'call', target: 'ghost1', method: 'stop', args: [] },
          ],
        },
      },
    } as unknown as LevelDoc
    const out = tool('lint').exec({}, ctxFor(bad)) as string
    expect(out).toContain('ghost1')
    expect(out).not.toContain('无问题')
  })

  it('read_run_log：空日志提示；错误条目带节点定位', () => {
    const doc = makeDoc()
    clearRunLog(doc.id)
    const empty = tool('read_run_log').exec({}, ctxFor(doc)) as string
    expect(empty).toContain('暂无试运行日志')
    appendRunLog(doc.id, { kind: 'command', path: 'sound1.play', t: 1 })
    appendRunLog(doc.id, { kind: 'error', message: 'boom', nodeId: 'c1', event: 'button1.clicked', t: 2 })
    const out = tool('read_run_log').exec({}, ctxFor(doc)) as string
    expect(out).toContain('[命令] sound1.play')
    expect(out).toContain('[错误](节点 c1)[button1.clicked] boom')
  })
})

describe('highlight_nodes（批次5）', () => {
  it('高亮合法节点 / 未知 id 拒绝 / 空数组清除', async () => {
    const { clearAiHighlight, getAiHighlight } = await import('../editor/graph/aiHighlight')
    const doc = blankLevelDoc()
    doc.content.components.push({ id: 'b1', type: 'button' } as never)
    doc.content.logic.nodes.push({ id: 'hl1', kind: 'comment', text: 'x' } as never)
    const ctx = { getDoc: () => doc, applyDoc: () => {}, levelId: doc.id } as ToolContext
    const hl = READONLY_TOOLS.find((t) => t.name === 'highlight_nodes')!
    clearAiHighlight()

    const ok = (await hl.exec({ nodeIds: ['hl1'], note: '看这里' }, ctx)) as string
    expect(ok).toContain('hl1')
    expect(getAiHighlight()).toEqual({ ids: ['hl1'], note: '看这里' })

    const bad = (await hl.exec({ nodeIds: ['ghost'] }, ctx)) as string
    expect(bad).toContain('都不存在')

    const cleared = (await hl.exec({ nodeIds: [] }, ctx)) as string
    expect(cleared).toContain('已清除')
    expect(getAiHighlight().ids).toEqual([])
  })
})

describe('capture_screen（批次8b）', () => {
  function shotTool() {
    return READONLY_TOOLS.find((t) => t.name === 'capture_screen')!
  }

  it('target 透传给 captureScreenshot，图片经 emitImages 进对话', async () => {
    const seen: string[] = []
    const calls: ('graph' | 'canvas' | 'debug' | undefined)[] = []
    const ctx: ToolContext = {
      getDoc: () => blankLevelDoc(),
      applyDoc: () => {},
      levelId: 'shot1',
      captureScreenshot: async (target) => {
        calls.push(target)
        return 'data:image/png;base64,SHOT'
      },
      emitImages: (imgs) => seen.push(...imgs),
    }
    const res = (await shotTool().exec({ target: 'canvas' }, ctx)) as string
    expect(res).toContain('关卡画布')
    expect(calls).toEqual(['canvas'])
    expect(seen).toEqual(['data:image/png;base64,SHOT'])

    const res2 = (await shotTool().exec({}, ctx)) as string
    expect(res2).toContain('节点图')
    expect(calls[1]).toBe('graph')
  })

  it('截不到目标（null）时返回可读指引；缺截图能力时明确说明', async () => {
    const ctxNull: ToolContext = {
      getDoc: () => blankLevelDoc(),
      applyDoc: () => {},
      levelId: 'shot2',
      captureScreenshot: async () => null,
      emitImages: () => {},
    }
    expect(await shotTool().exec({ target: 'canvas' }, ctxNull)).toContain('没有关卡画布')
    expect(await shotTool().exec({ target: 'graph' }, ctxNull)).toContain('不可用')

    const ctxNoCap: ToolContext = { getDoc: () => blankLevelDoc(), applyDoc: () => {}, levelId: 'shot3' }
    expect(await shotTool().exec({ target: 'graph' }, ctxNoCap)).toContain('不支持截图')
  })
})

describe('capture_screen debug 目标（批次9）', () => {
  function shotTool() {
    return READONLY_TOOLS.find((t) => t.name === 'capture_screen')!
  }

  it('target=debug 透传并标注「调试画面」；无可见会话（null）给启动指引', async () => {
    const calls: unknown[] = []
    const base: ToolContext = {
      getDoc: () => blankLevelDoc(),
      applyDoc: () => {},
      levelId: 'shot9',
      captureScreenshot: async (target) => {
        calls.push(target)
        return 'data:image/png;base64,D'
      },
      emitImages: () => {},
    }
    const res = (await shotTool().exec({ target: 'debug' }, base)) as string
    expect(calls).toEqual(['debug'])
    expect(res).toContain('调试画面')

    // 无可见调试会话：captureScreenshot 返回 null → 文案给 debug_control 启动指引
    const ctx2: ToolContext = { ...base, captureScreenshot: async () => null }
    const res2 = (await shotTool().exec({ target: 'debug' }, ctx2)) as string
    expect(res2).toContain('debug_control')
  })
})
