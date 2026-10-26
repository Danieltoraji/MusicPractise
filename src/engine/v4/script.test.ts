/**
 * v4 伪代码投影测试（docs/52 §4 W6.4 / docs/53 §13.5）：
 * - 两种层 generate→parse→generate 往返恒等（文本稳定，注释/顺序不漂移）；
 * - 解析产物结构正确（分支汇合/循环回边/双出口端口）；
 * - 锚点合并：二次编辑保留未改语句的节点 id 与 x/y、改写语句拿新 id、无 id 冲突/悬空边/自环；
 * - 非法输入给可读中文（带行号）；不可表达的图给可读错误而不是静默丢节点；
 * - 变量/局部变量声明块可往返（不依赖编辑器变量面板外部输入）。
 */
import { describe, expect, it } from 'vitest'
import type { BehaviorNode, BehaviorProgram, FlowNode, FlowProgram } from './model'
import { LOGIC_VERSION_V4 } from './model'
import {
  ScriptError,
  generateBehaviorScript,
  generateFlowScript,
  mergeBehaviorScriptAnchors,
  mergeFlowScriptAnchors,
  nodeScriptText,
  parseBehaviorScript,
  parseFlowScript,
} from './script'

// ---------------------------------------------------------------------------
// 夹具：一段结构可表达的 flow 主流程（含 vars/注释/foreach/branch/loop/双出口）
// ---------------------------------------------------------------------------

function richFlow(): FlowProgram {
  const nodes: FlowNode[] = [
    { id: 'f_start', kind: 'start', x: 0, y: 0 },
    { id: 'f_init', kind: 'assign', target: 'v.score', value: { expr: '0' }, x: 220, y: 0 },
    { id: 'f_fe', kind: 'foreach', items: 'run.questions', itemVar: 'slot', indexVar: 'i', x: 440, y: 0 },
    { id: 'f_ask', kind: 'ask', target: 'local.slot', args: '{ difficulty: 2 }', resultVar: 'result', x: 660, y: 0 },
    { id: 'f_join', kind: 'comment', text: '答对才加分', x: 0, y: 220 },
    { id: 'f_br', kind: 'branch', cond: 'local.result.scoreDelta != null', x: 880, y: 0 },
    { id: 'f_add', kind: 'assign', target: 'v.score', value: { expr: 'v.score + local.result.scoreDelta' }, x: 1100, y: 0 },
    { id: 'f_note', kind: 'wait', ms: '120', x: 1320, y: 0 },
    { id: 'f_lp', kind: 'loop', mode: 'repeat', times: '2', x: 1540, y: 0 },
    { id: 'f_sv', kind: 'setView', view: 'main', x: 1760, y: 0 },
    { id: 'f_ws', kind: 'waitShell', event: 'scoreLabel.settled', x: 1980, y: 0 },
    { id: 'f_fin', kind: 'finish', passed: 'v.score >= 60', x: 2200, y: 0 },
  ]
  const edges = [
    { id: 'e1', from: 'f_start', to: 'f_init' },
    { id: 'e2', from: 'f_init', to: 'f_fe' },
    { id: 'e3', from: 'f_fe', to: 'f_ask', port: 'true' as const },
    { id: 'e4', from: 'f_ask', to: 'f_br' },
    { id: 'e5', from: 'f_br', to: 'f_add', port: 'true' as const },
    { id: 'e6', from: 'f_br', to: 'f_note', port: 'false' as const },
    { id: 'e7', from: 'f_add', to: 'f_note' },
    { id: 'e8', from: 'f_note', to: 'f_fe' },
    { id: 'e9', from: 'f_fe', to: 'f_lp', port: 'false' as const },
    { id: 'e10', from: 'f_lp', to: 'f_sv', port: 'true' as const },
    { id: 'e11', from: 'f_sv', to: 'f_lp' },
    { id: 'e12', from: 'f_lp', to: 'f_ws', port: 'false' as const },
    { id: 'e13', from: 'f_ws', to: 'f_fin' },
  ]
  return {
    logicVersion: LOGIC_VERSION_V4,
    kind: 'flow',
    nodes,
    edges,
    vars: [
      { key: 'score', type: 'number', init: 0 },
      { key: 'label', type: 'string', init: '得分' },
      { key: 'done', type: 'boolean', init: false },
      { key: 'log', type: 'json', init: [] },
    ],
  }
}

function richBehavior(): BehaviorProgram {
  const nodes: BehaviorNode[] = [
    { id: 'b_on_start', kind: 'on', event: 'start', x: 0, y: 0 },
    { id: 'b_call_play', kind: 'call', target: 'sound1', method: 'play', arg: '{ notes: q.notes }', x: 220, y: 0 },
    { id: 'b_comment', kind: 'comment', text: '选择事件：判分', x: 0, y: 260 },
    { id: 'b_on_chosen', kind: 'on', event: 'choice1.chosen', x: 0, y: 160 },
    { id: 'b_assign_t', kind: 'assign', target: 't.asked', value: { expr: 't.asked + 1' }, x: 220, y: 160 },
    { id: 'b_br', kind: 'branch', cond: 'event.payload.index == q.answerIndex', x: 440, y: 160 },
    { id: 'b_assign_ok', kind: 'assign', target: 'q.state.answered', value: { expr: 'true' }, x: 660, y: 160 },
    { id: 'b_emit', kind: 'emit', event: 'internal.judged', payload: { ok: 'true', score: 'q.scoring' }, x: 880, y: 160 },
    { id: 'b_ret', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: q.scoring }", x: 1100, y: 160 },
    { id: 'b_br2', kind: 'branch', cond: 'event.payload.index == 0', x: 660, y: 300 },
    { id: 'b_wait', kind: 'wait', ms: '200', x: 880, y: 300 },
    { id: 'b_ret_bad', kind: 'return', result: "{ status: 'answered', correct: false }", x: 1100, y: 300 },
    { id: 'b_on_internal', kind: 'on', event: 'internal.judged', x: 0, y: 420 },
    { id: 'b_loop', kind: 'loop', mode: 'while', cond: 'local.retries < 2', x: 220, y: 420 },
    { id: 'b_retry', kind: 'assign', target: 'local.retries', value: { query: { target: 'slider1', method: 'getValue' } }, x: 440, y: 420 },
    { id: 'b_return_loop', kind: 'return', result: "{ status: 'skipped' }", x: 660, y: 420 },
  ]
  const edges = [
    { id: 'be1', from: 'b_on_start', to: 'b_call_play' },
    { id: 'be2', from: 'b_on_chosen', to: 'b_assign_t' },
    { id: 'be3', from: 'b_assign_t', to: 'b_br' },
    { id: 'be4', from: 'b_br', to: 'b_assign_ok', port: 'true' as const },
    { id: 'be5', from: 'b_assign_ok', to: 'b_emit' },
    { id: 'be6', from: 'b_emit', to: 'b_ret' },
    { id: 'be7', from: 'b_br', to: 'b_br2', port: 'false' as const },
    { id: 'be8', from: 'b_br2', to: 'b_wait', port: 'true' as const },
    { id: 'be9', from: 'b_wait', to: 'b_ret_bad' },
    { id: 'be10', from: 'b_br2', to: 'b_ret_bad', port: 'false' as const },
    { id: 'be11', from: 'b_on_internal', to: 'b_loop' },
    { id: 'be12', from: 'b_loop', to: 'b_retry', port: 'true' as const },
    { id: 'be13', from: 'b_retry', to: 'b_loop' },
    { id: 'be14', from: 'b_loop', to: 'b_return_loop', port: 'false' as const },
  ]
  return {
    logicVersion: LOGIC_VERSION_V4,
    kind: 'behavior',
    nodes,
    edges,
    locals: [
      { key: 'retries', type: 'number', init: 0 },
      { key: 'last', type: 'json', init: null },
    ],
  }
}

describe('v4 伪代码 · flow 往返恒等', () => {
  it('generate→parse→generate 文本完全一致（含 vars/注释/foreach/branch/loop）', () => {
    const program = richFlow()
    const first = generateFlowScript(program)
    const reparsed = parseFlowScript(first)
    expect(generateFlowScript(reparsed)).toBe(first)
  })

  it('生成文本包含 docs/53 §13.5 的关键结构', () => {
    const text = generateFlowScript(richFlow())
    expect(text).toContain('vars {')
    expect(text).toContain('v.score: number = 0')
    expect(text).toContain('main {')
    expect(text).toContain('// 答对才加分')
    expect(text).toContain('foreach slot, i in run.questions {')
    expect(text).toContain('ask local.slot with { difficulty: 2 } -> result')
    expect(text).toContain('if (local.result.scoreDelta != null) {')
    expect(text).toContain('repeat (2) {')
    expect(text).toContain('waitShell scoreLabel.settled')
    expect(text).toContain('finish passed: v.score >= 60')
  })

  it('解析产物结构正确：双出口端口、循环体回边、分支汇合', () => {
    const program = parseFlowScript(generateFlowScript(richFlow()))
    const byId = new Map(program.nodes.map((node) => [node.id, node]))
    const kinds = program.nodes.map((node) => node.kind)
    expect(kinds).toContain('start')
    expect(kinds).toContain('foreach')
    expect(kinds).toContain('loop')
    expect(kinds).toContain('branch')
    expect(kinds.filter((kind) => kind === 'comment')).toHaveLength(1)
    // start 无入边
    const start = program.nodes.find((node) => node.kind === 'start')
    expect(start).toBeTruthy()
    expect(program.edges.some((edge) => edge.to === (start as FlowNode).id)).toBe(false)
    // foreach：true 出口通往体、false 出口通往循环外；体尾回边指回 foreach
    const foreach = program.nodes.find((node) => node.kind === 'foreach')
    expect(foreach).toBeTruthy()
    const feTrue = program.edges.find((edge) => edge.from === foreach!.id && edge.port === 'true')
    const feFalse = program.edges.find((edge) => edge.from === foreach!.id && edge.port === 'false')
    expect(feTrue).toBeTruthy()
    expect(feFalse).toBeTruthy()
    expect(program.edges.some((edge) => edge.to === foreach!.id)).toBe(true)
    // loop 的体尾回边 + false 出口
    const loop = program.nodes.find((node) => node.kind === 'loop')
    expect(program.edges.some((edge) => edge.to === loop!.id)).toBe(true)
    expect(program.edges.find((edge) => edge.from === loop!.id && edge.port === 'false')).toBeTruthy()
    // 分支汇合：true/false 两支最终都连到同一个 wait 节点
    const branch = program.nodes.find((node) => node.kind === 'branch')
    const brTrue = program.edges.find((edge) => edge.from === branch!.id && edge.port === 'true')
    const brFalse = program.edges.find((edge) => edge.from === branch!.id && edge.port === 'false')
    expect(brTrue).toBeTruthy()
    expect(brFalse).toBeTruthy()
    // 双出口节点不允许缺 port、单出口节点不允许带 port
    for (const edge of program.edges) {
      const from = byId.get(edge.from)
      expect(from).toBeTruthy()
      const dual = from!.kind === 'branch' || from!.kind === 'loop' || from!.kind === 'foreach'
      if (dual) expect(edge.port).toBeTruthy()
      else expect(edge.port).toBeUndefined()
      expect(edge.from).not.toBe(edge.to)
    }
  })

  it('if/else if/else 链往返稳定（分支嵌套汇合）', () => {
    const program: FlowProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'flow',
      nodes: [
        { id: 's', kind: 'start' },
        { id: 'b1', kind: 'branch', cond: 'v.a == 1' },
        { id: 'n1', kind: 'call', target: 'label1', method: 'setText', arg: "{ text: 'a' }" },
        { id: 'b2', kind: 'branch', cond: 'v.a == 2' },
        { id: 'n2', kind: 'call', target: 'label1', method: 'setText', arg: "{ text: 'b' }" },
        { id: 'n3', kind: 'call', target: 'label1', method: 'setText', arg: "{ text: 'c' }" },
        { id: 'j', kind: 'finish' },
      ],
      edges: [
        { id: 'e1', from: 's', to: 'b1' },
        { id: 'e2', from: 'b1', to: 'n1', port: 'true' },
        { id: 'e3', from: 'b1', to: 'b2', port: 'false' },
        { id: 'e4', from: 'n1', to: 'j' },
        { id: 'e5', from: 'b2', to: 'n2', port: 'true' },
        { id: 'e6', from: 'b2', to: 'n3', port: 'false' },
        { id: 'e7', from: 'n2', to: 'j' },
        { id: 'e8', from: 'n3', to: 'j' },
      ],
    }
    const text = generateFlowScript(program)
    expect(text).toContain('} else if (v.a == 2) {')
    expect(generateFlowScript(parseFlowScript(text))).toBe(text)
  })

  it('空主流程/restart 结尾/无 vars 时也稳定', () => {
    const empty: FlowProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'flow',
      nodes: [
        { id: 's', kind: 'start' },
        { id: 'r', kind: 'restart' },
      ],
      edges: [{ id: 'e', from: 's', to: 'r' }],
    }
    const text = generateFlowScript(empty)
    expect(text).not.toContain('vars {')
    expect(text).toContain('restart')
    expect(generateFlowScript(parseFlowScript(text))).toBe(text)
  })
})

describe('v4 伪代码 · behavior 往返恒等', () => {
  it('generate→parse→generate 文本完全一致（locals/多 handler/emit 负载/return）', () => {
    const program = richBehavior()
    const first = generateBehaviorScript(program)
    const reparsed = parseBehaviorScript(first)
    expect(generateBehaviorScript(reparsed)).toBe(first)
  })

  it('生成文本包含 docs/53 §13.5 的关键结构', () => {
    const text = generateBehaviorScript(richBehavior())
    expect(text).toContain('locals {')
    expect(text).toContain('local.retries: number = 0')
    expect(text).toContain('// 选择事件：判分')
    expect(text).toContain('on start {')
    expect(text).toContain('on choice1.chosen {')
    expect(text).toContain('call sound1.play({ notes: q.notes })')
    expect(text).toContain('emit "internal.judged" {ok: true, score: q.scoring}')
    expect(text).toContain("return { status: 'answered', correct: true, scoreDelta: q.scoring }")
    expect(text).toContain('while (local.retries < 2) {')
  })

  it('解析产物行为结构正确：多 handler、return 终止、emit 负载、循环回边', () => {
    const program = parseBehaviorScript(generateBehaviorScript(richBehavior()))
    const handlers = program.nodes.filter((node) => node.kind === 'on')
    expect(handlers.map((node) => (node as { event: string }).event)).toEqual([
      'start',
      'choice1.chosen',
      'internal.judged',
    ])
    const returns = program.nodes.filter((node) => node.kind === 'return')
    expect(returns).toHaveLength(3)
    for (const ret of returns) {
      expect(program.edges.some((edge) => edge.from === ret.id)).toBe(false)
    }
    const emit = program.nodes.find((node) => node.kind === 'emit') as Extract<BehaviorNode, { kind: 'emit' }>
    expect(emit.payload).toEqual({ ok: 'true', score: 'q.scoring' })
    const loop = program.nodes.find((node) => node.kind === 'loop')
    expect(program.edges.some((edge) => edge.to === loop!.id)).toBe(true)
  })

  it('空 handler（on 后没有语句）可往返', () => {
    const program: BehaviorProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'behavior',
      nodes: [
        { id: 'b1', kind: 'on', event: 'start' },
        { id: 'b2', kind: 'on', event: 'internal.ping' },
      ],
      edges: [],
    }
    const text = generateBehaviorScript(program)
    expect(text).toContain('on start {')
    expect(generateBehaviorScript(parseBehaviorScript(text))).toBe(text)
  })
})

describe('v4 伪代码 · 锚点合并（二次编辑保留 id/x/y）', () => {
  it('flow：未改语句保留 id 与坐标，改写语句获得新 id，无 id 冲突/悬空/自环', () => {
    const prev = richFlow()
    const text = generateFlowScript(prev)
    // 只改「加分的表达式」+ 改等待时长：其余语句应继承锚点
    const edited = text
      .replace('v.score + local.result.scoreDelta', 'v.score + 10')
      .replace('wait 120', 'wait 240')
    const parsed = parseFlowScript(edited)
    const merged = mergeFlowScriptAnchors(parsed, prev)
    expect(merged.kept).toBeGreaterThan(0)
    expect(merged.unmatched).toBe(2)
    expect(merged.dropped).toBe(0)
    const ids = merged.program.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    // 未改语句的节点 id 保留
    const init = merged.program.nodes.find((node) => node.kind === 'assign' && 'expr' in node.value && node.value.expr === '0')
    expect(init?.id).toBe('f_init')
    const start = merged.program.nodes.find((node) => node.kind === 'start')
    expect(start?.id).toBe('f_start')
    expect(start?.x).toBe(0)
    expect(start?.y).toBe(0)
    // 改写语句拿到新 id（不再是旧 id）
    const changed = merged.program.nodes.find(
      (node) => node.kind === 'assign' && 'expr' in node.value && node.value.expr === 'v.score + 10',
    )
    expect(changed).toBeTruthy()
    expect(changed!.id).not.toBe('f_add')
    expect(changed!.x).toBeUndefined()
    // 坐标继承：未改节点的 x/y 与旧图一致
    const foreach = merged.program.nodes.find((node) => node.kind === 'foreach')
    expect(foreach?.id).toBe('f_fe')
    expect(foreach?.x).toBe(440)
    // 边端点全部有效、无自环
    const nodeIds = new Set(merged.program.nodes.map((node) => node.id))
    for (const edge of merged.program.edges) {
      expect(nodeIds.has(edge.from)).toBe(true)
      expect(nodeIds.has(edge.to)).toBe(true)
      expect(edge.from).not.toBe(edge.to)
    }
  })

  it('flow：旧图 id 恰好等于解析前缀时也不产生 id 冲突', () => {
    // 旧图本身就是「脚本产物」风格（s1/s2/s3）：编辑后重解析仍生成 s1..，合并必须改掉冲突
    const prev: FlowProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'flow',
      nodes: [
        { id: 's1', kind: 'start', x: 10, y: 10 },
        { id: 's2', kind: 'assign', target: 'v.score', value: { expr: '0' }, x: 100, y: 10 },
        { id: 's3', kind: 'finish', x: 200, y: 10 },
      ],
      edges: [
        { id: 'se1', from: 's1', to: 's2' },
        { id: 'se2', from: 's2', to: 's3' },
      ],
      vars: [{ key: 'score', type: 'number', init: 0 }],
    }
    const text = generateFlowScript(prev)
      .replace('v.score: number = 0', 'v.score: number = 5')
      .replace('  v.score = 0', '  v.score = 1')
    const merged = mergeFlowScriptAnchors(parseFlowScript(text), prev)
    const ids = merged.program.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    // 未改的 start/finish 继承旧 id 与坐标；改写的 assign 拿新 id（但不得与旧 id 撞车）
    expect(merged.program.nodes.find((node) => node.kind === 'start')?.id).toBe('s1')
    expect(merged.program.nodes.find((node) => node.kind === 'finish')?.id).toBe('s3')
    expect(merged.program.nodes.find((node) => node.kind === 'assign')?.id).not.toBe('s2')
    // vars 取自解析文本（初值 5）
    expect(merged.program.vars).toEqual([{ key: 'score', type: 'number', init: 5 }])
  })

  it('behavior：保留旧 id/x/y，未接线节点计入 dropped', () => {
    const prev = richBehavior()
    // 追加一个不可达节点（脚本不表达，应用时丢弃）
    prev.nodes.push({ id: 'b_orphan', kind: 'assign', target: 'q.state.answered', value: { expr: 'false' }, x: 5, y: 5 })
    const text = generateBehaviorScript(prev)
    const merged = mergeBehaviorScriptAnchors(parseBehaviorScript(text), prev)
    expect(merged.dropped).toBe(1)
    expect(merged.unmatched).toBe(0)
    expect(merged.program.nodes.some((node) => node.id === 'b_orphan')).toBe(false)
    const onChosen = merged.program.nodes.find(
      (node) => node.kind === 'on' && (node as { event: string }).event === 'choice1.chosen',
    )
    expect(onChosen?.id).toBe('b_on_chosen')
    expect(onChosen?.x).toBe(0)
    expect(onChosen?.y).toBe(160)
  })

  it('合并后回填的节点（含注释）都能被 lint/validate 接受（flow 结构自洽）', () => {
    // start→assign→finish 的最小可装载结构（夹具里的 shell 组件 id 不参与）
    const prev: FlowProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'flow',
      nodes: [
        { id: 'start_1', kind: 'start' },
        { id: 'assign_1', kind: 'assign', target: 'v.score', value: { expr: '0' } },
        { id: 'comment_1', kind: 'comment', text: '热身' },
        { id: 'finish_1', kind: 'finish' },
      ],
      edges: [
        { id: 'e1', from: 'start_1', to: 'assign_1' },
        { id: 'e2', from: 'assign_1', to: 'finish_1' },
      ],
      vars: [{ key: 'score', type: 'number', init: 0 }],
    }
    const text = generateFlowScript(prev)
    const merged = mergeFlowScriptAnchors(parseFlowScript(text), prev)
    const ids = new Set(merged.program.nodes.map((node) => node.id))
    for (const node of merged.program.nodes) {
      // 不允许显式 undefined（JSON/schema 往返会丢字段或报错）
      for (const [key, value] of Object.entries(node)) expect(value, `${node.id}.${key}`).not.toBeUndefined()
    }
    for (const edge of merged.program.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
    expect(merged.program.nodes.map((node) => node.id)).toEqual([
      'start_1',
      'comment_1',
      'assign_1',
      'finish_1',
    ])
  })
})

describe('v4 伪代码 · 非法输入与不可表达结构的可读报错', () => {
  it('缺少配对右花括号 / 未知语句 / 表达式语法错误都给行号中文', () => {
    const missingBrace = 'main {\n  v.score = 0\n'
    expect(() => parseFlowScript(missingBrace)).toThrow(ScriptError)
    expect(() => parseFlowScript(missingBrace)).toThrow(/缺少配对的/)

    const unknown = 'main {\n  v.score = 0\n  这是什么\n}'
    expect(() => parseFlowScript(unknown)).toThrow(/第 3 行/)
    expect(() => parseFlowScript(unknown)).toThrow(/无法识别的语句/)

    const badExpr = 'main {\n  if (v.score >) {\n  }\n}'
    expect(() => parseFlowScript(badExpr)).toThrow(/第 2 行/)
    expect(() => parseFlowScript(badExpr)).toThrow(/if 条件/)

    const badRoot = 'main {\n  if (event.payload.x == 1) {\n  }\n}'
    expect(() => parseFlowScript(badRoot)).toThrow(/未定义的标识符 "event"/)

    const badWrite = 'main {\n  q.state.answered = true\n}'
    expect(() => parseFlowScript(badWrite)).toThrow(/流程层只能写/)

    const badBehaviorWrite = 'on start {\n  v.score = 0\n}'
    expect(() => parseBehaviorScript(badBehaviorWrite)).toThrow(/行为层/)

    const emptyLoop = 'main {\n  while (true) {\n  }\n}'
    expect(() => parseFlowScript(emptyLoop)).toThrow(/循环体不能为空/)

    const emitOutside = 'main {\n  emit "internal.x"\n}'
    expect(() => parseFlowScript(emitOutside)).toThrow(/不支持 emit/)

    const missingMain = 'on start {\n}'
    expect(() => parseFlowScript(missingMain)).toThrow(/main/)
  })

  it('生成侧：结构越界抛可读错误而非静默丢节点', () => {
    // 普通节点形成环（非 loop 回边）：伪代码无法表达
    const cycle: FlowProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'flow',
      nodes: [
        { id: 's', kind: 'start' },
        { id: 'a', kind: 'call', target: 'label1', method: 'setText', arg: "{ text: 'x' }" },
        { id: 'b', kind: 'finish' },
      ],
      edges: [
        { id: 'e1', from: 's', to: 'a' },
        { id: 'e2', from: 'a', to: 'b' },
        { id: 'e3', from: 'b', to: 'a' },
      ],
    }
    expect(() => generateFlowScript(cycle)).toThrow(/多条路径汇入/)
    // 循环体没有回边
    const brokenLoop: FlowProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'flow',
      nodes: [
        { id: 's', kind: 'start' },
        { id: 'lp', kind: 'loop', mode: 'repeat', times: '2' },
        { id: 'f', kind: 'finish' },
      ],
      edges: [
        { id: 'e1', from: 's', to: 'lp' },
        { id: 'e2', from: 'lp', to: 'f', port: 'true' },
        { id: 'e3', from: 'lp', to: 'f', port: 'false' },
      ],
    }
    expect(() => generateFlowScript(brokenLoop)).toThrow(/循环体/)
    // 注释接线（v4 validate 禁止）
    const wiredComment: FlowProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'flow',
      nodes: [
        { id: 's', kind: 'start' },
        { id: 'cm', kind: 'comment', text: '说明' },
        { id: 'f', kind: 'finish' },
      ],
      edges: [
        { id: 'e1', from: 's', to: 'cm' },
        { id: 'e2', from: 'cm', to: 'f' },
      ],
    }
    expect(() => generateFlowScript(wiredComment)).toThrow(/注释节点/)
  })

  it('节点字段缺失/非法时生成侧报可读错误', () => {
    const missingCond: FlowProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'flow',
      nodes: [
        { id: 's', kind: 'start' },
        { id: 'b', kind: 'branch', cond: '  ' },
      ],
      edges: [{ id: 'e', from: 's', to: 'b' }],
    }
    expect(() => generateFlowScript(missingCond)).toThrow(/分支条件/)
    const badEvent: BehaviorProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'behavior',
      nodes: [
        { id: 'b', kind: 'on', event: 'wrong-event' },
        { id: 'r', kind: 'return', result: "{ status: 'answered' }" },
      ],
      edges: [{ id: 'e', from: 'b', to: 'r' }],
    }
    expect(() => generateBehaviorScript(badEvent)).toThrow(/on 事件/)
  })
})

describe('v4 伪代码 · 语句特征文本（生成器/锚点合并共用口径）', () => {
  it('nodeScriptText 为单行；块头不带大括号', () => {
    expect(nodeScriptText({ id: 'x', kind: 'branch', cond: 'v.a == 1' })).toBe('if (v.a == 1)')
    expect(nodeScriptText({ id: 'x', kind: 'loop', mode: 'while', cond: 'v.ok' })).toBe('while (v.ok)')
    expect(nodeScriptText({ id: 'x', kind: 'assign', target: 'local.n', value: { expr: '1' } })).toBe('local.n = 1')
    expect(
      nodeScriptText({
        id: 'x',
        kind: 'emit',
        event: 'internal.ping',
        payload: { ok: 'true' },
      }),
    ).toBe('emit "internal.ping" {ok: true}')
    expect(nodeScriptText({ id: 'x', kind: 'comment', text: '多行\n注释' })).toBe('// 多行 注释')
  })
})
