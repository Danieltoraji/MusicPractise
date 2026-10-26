import { describe, expect, it } from 'vitest'
import { lintLevelDocV4, type V4LintCtx } from './lint'
import { minimalLevelDoc } from './fixtures'
import type { BehaviorNode, FlowNode, LevelDocV4 } from './model'
import type { V4Issue } from './validate'

type StubContract = { events: Record<string, string>; commands: Record<string, string>; queries: Record<string, string> }

const CTX: V4LintCtx = {
  contractOf: (type): StubContract | undefined => {
    switch (type) {
      case 'label':
        return { events: { clicked: '' }, commands: { setText: '', show: '' }, queries: {} }
      case 'choice':
        return { events: { chosen: '' }, commands: { setOptions: '', reveal: '', reset: '' }, queries: {} }
      case 'button':
        return { events: { clicked: '' }, commands: { setText: '', setEnabled: '' }, queries: {} }
      case 'sound':
        return { events: {}, commands: { play: '' }, queries: {} }
      default:
        return undefined
    }
  },
}

function issues(doc: LevelDocV4): V4Issue[] {
  return lintLevelDocV4(doc, CTX)
}

function codes(doc: LevelDocV4): string[] {
  return issues(doc).map((i) => i.code)
}

function expectIssue(doc: LevelDocV4, code: string): void {
  expect(codes(doc), JSON.stringify(issues(doc), null, 2)).toContain(code)
}

function expectNoIssue(doc: LevelDocV4, code: string): void {
  expect(codes(doc), JSON.stringify(issues(doc), null, 2)).not.toContain(code)
}

function flowNode(doc: LevelDocV4, id: string): Record<string, unknown> {
  const node = doc.content.flow.nodes.find((n) => n.id === id)
  if (!node) throw new Error(`fixture 缺流程节点 ${id}`)
  return node as unknown as Record<string, unknown>
}

function behaviorReturn(doc: LevelDocV4): Record<string, unknown> {
  const node = doc.content.types[0].behavior.nodes.find((n) => n.kind === 'return')
  if (!node) throw new Error('fixture 缺 behavior return')
  return node as unknown as Record<string, unknown>
}

function pushFlow(doc: LevelDocV4, node: Record<string, unknown>): void {
  doc.content.flow.nodes.push(node as unknown as FlowNode)
}

function pushBehavior(doc: LevelDocV4, node: Record<string, unknown>): void {
  doc.content.types[0].behavior.nodes.push(node as unknown as BehaviorNode)
}

describe('v4 lint：夹具基线', () => {
  it('最小夹具无语义问题', () => {
    expect(issues(minimalLevelDoc())).toEqual([])
  })
})

describe('v4 lint：表达式根/路径/语法', () => {
  it('流程层非法根（q.*）与语法错误', () => {
    const root = minimalLevelDoc()
    flowNode(root, 'f_init').value = { expr: 'q.prompt' }
    expectIssue(root, 'V4_EXPR_ROOT')

    const syntax = minimalLevelDoc()
    flowNode(syntax, 'f_finish').passed = 'v.score >'
    expectIssue(syntax, 'V4_EXPR_SYNTAX')
  })

  it('流程层未声明 v.*/run.* 路径', () => {
    const vPath = minimalLevelDoc()
    flowNode(vPath, 'f_finish').passed = 'v.ghost > 0'
    expectIssue(vPath, 'V4_EXPR_PATH')

    const runPath = minimalLevelDoc()
    flowNode(runPath, 'f_finish').passed = 'run.ghost'
    expectIssue(runPath, 'V4_EXPR_PATH')

    const runOk = minimalLevelDoc()
    flowNode(runOk, 'f_finish').passed = 'run.total > 0'
    expectNoIssue(runOk, 'V4_EXPR_PATH')
  })

  it('行为层 q/t/args/local/v/event/run 路径校验', () => {
    const cases: [string, string][] = [
      ['q.ghost', 'V4_EXPR_PATH'],
      ['q.state.ghost', 'V4_EXPR_PATH'],
      ['t.ghost', 'V4_EXPR_PATH'],
      ['args.ghost', 'V4_EXPR_PATH'],
      ['v.ghost', 'V4_EXPR_PATH'],
      ['local.ghost', 'V4_EXPR_PATH'],
      ['event.ghost', 'V4_EXPR_PATH'],
      ['run.ghost', 'V4_EXPR_PATH'],
    ]
    for (const [expr, code] of cases) {
      const doc = minimalLevelDoc()
      behaviorReturn(doc).result = expr
      expectIssue(doc, code)
    }
    const ok = minimalLevelDoc()
    behaviorReturn(ok).result = "{ status: 'answered', correct: q.state.answered, message: q.prompt }"
    expectNoIssue(ok, 'V4_EXPR_PATH')
    expectNoIssue(ok, 'V4_EXPR_ROOT')
  })
})

describe('v4 lint：写权限', () => {
  it('flow 不能写 q.state / 未声明 v.*；可写隐式 local.*', () => {
    const qState = minimalLevelDoc()
    flowNode(qState, 'f_init').target = 'q.state.answered'
    expectIssue(qState, 'V4_WRITE_DENIED')

    const ghostVar = minimalLevelDoc()
    flowNode(ghostVar, 'f_init').target = 'v.ghost'
    expectIssue(ghostVar, 'V4_WRITE_DENIED')

    const localOk = minimalLevelDoc()
    pushFlow(localOk, { id: 'f_local', kind: 'assign', target: 'local.count', value: { expr: '1' } })
    expectNoIssue(localOk, 'V4_WRITE_DENIED')
  })

  it('behavior 不能写 v.*；q.state/t 已声明字段可写', () => {
    const vWrite = minimalLevelDoc()
    pushBehavior(vWrite, { id: 'b_assign', kind: 'assign', target: 'v.score', value: { expr: '1' } })
    expectIssue(vWrite, 'V4_WRITE_DENIED')

    const ok = minimalLevelDoc()
    pushBehavior(ok, { id: 'b_a1', kind: 'assign', target: 'q.state.answered', value: { expr: 'true' } })
    pushBehavior(ok, { id: 'b_a2', kind: 'assign', target: 't.asked', value: { expr: '1' } })
    expectNoIssue(ok, 'V4_WRITE_DENIED')

    const ghostState = minimalLevelDoc()
    pushBehavior(ghostState, { id: 'b_a3', kind: 'assign', target: 'q.state.ghost', value: { expr: '1' } })
    expectIssue(ghostState, 'V4_WRITE_DENIED')
  })
})

describe('v4 lint：组件契约（命令/查询/事件）', () => {
  it('flow call 命令必须在 shell 组件契约中', () => {
    const bad = minimalLevelDoc()
    pushFlow(bad, { id: 'f_call', kind: 'call', target: 'scoreLabel', method: 'nope' })
    expectIssue(bad, 'V4_UNKNOWN_METHOD')

    const good = minimalLevelDoc()
    pushFlow(good, { id: 'f_call', kind: 'call', target: 'scoreLabel', method: 'setText', arg: "{text: 'hi'}" })
    expectNoIssue(good, 'V4_UNKNOWN_METHOD')
  })

  it('behavior call 命令必须在 surface 契约中', () => {
    const bad = minimalLevelDoc()
    pushBehavior(bad, { id: 'b_call', kind: 'call', target: 'choice1', method: 'open' })
    expectIssue(bad, 'V4_UNKNOWN_METHOD')

    const good = minimalLevelDoc()
    pushBehavior(good, { id: 'b_call', kind: 'call', target: 'choice1', method: 'reveal', arg: '{correctIndex: 0}' })
    expectNoIssue(good, 'V4_UNKNOWN_METHOD')
  })

  it('waitShell/on 组件事件必须在契约中', () => {
    const waitBad = minimalLevelDoc()
    pushFlow(waitBad, { id: 'f_wait', kind: 'waitShell', event: 'scoreLabel.nope' })
    expectIssue(waitBad, 'V4_UNKNOWN_EVENT')

    const waitGood = minimalLevelDoc()
    pushFlow(waitGood, { id: 'f_wait', kind: 'waitShell', event: 'scoreLabel.clicked' })
    expectNoIssue(waitGood, 'V4_UNKNOWN_EVENT')

    const onBad = minimalLevelDoc()
    pushBehavior(onBad, { id: 'b_on', kind: 'on', event: 'choice1.nope' })
    expectIssue(onBad, 'V4_UNKNOWN_EVENT')

    const onGood = minimalLevelDoc()
    pushBehavior(onGood, { id: 'b_on', kind: 'on', event: 'choice1.chosen' })
    expectNoIssue(onGood, 'V4_UNKNOWN_EVENT')
  })

  it('assign 查询方法必须在契约 queries 中', () => {
    const bad = minimalLevelDoc()
    flowNode(bad, 'f_init').value = { query: { target: 'scoreLabel', method: 'getText' } }
    expectIssue(bad, 'V4_UNKNOWN_METHOD')
  })
})

describe('v4 lint：图语义', () => {
  it('不可达节点 → warning', () => {
    const doc = minimalLevelDoc()
    pushFlow(doc, { id: 'f_orphan', kind: 'assign', target: 'v.score', value: { expr: '1' } })
    expectIssue(doc, 'V4_UNREACHABLE')
  })

  it('未结算结束路径 → warning', () => {
    const doc = minimalLevelDoc()
    doc.content.flow.nodes = doc.content.flow.nodes.filter((n) => n.kind !== 'finish')
    doc.content.flow.edges = [{ id: 'fe_1', from: 'f_start', to: 'f_init' }]
    expectIssue(doc, 'V4_UNSETTLED_FLOW')
  })

  it('finish 之后的 ask/assign/branch → error', () => {
    const doc = minimalLevelDoc()
    doc.content.flow.nodes.push({ id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' })
    doc.content.flow.edges.push({ id: 'fe_after', from: 'f_finish', to: 'f_ask' })
    expectIssue(doc, 'V4_ASK_AFTER_FINISH')

    const allowed = minimalLevelDoc()
    allowed.content.flow.nodes.push({ id: 'f_restart', kind: 'restart' })
    allowed.content.flow.edges.push({ id: 'fe_after', from: 'f_finish', to: 'f_restart' })
    expectNoIssue(allowed, 'V4_ASK_AFTER_FINISH')
  })

  it('行为 handler 无法到达 return → warning', () => {
    const doc = minimalLevelDoc()
    doc.content.types[0].behavior.nodes = doc.content.types[0].behavior.nodes.filter((n) => n.kind !== 'return')
    doc.content.types[0].behavior.edges = []
    expectIssue(doc, 'V4_BEHAVIOR_NO_RETURN')
  })

  it('内部事件配对：未处理的 emit 警告；补 on 后消除', () => {
    const doc = minimalLevelDoc()
    pushBehavior(doc, { id: 'b_emit', kind: 'emit', event: 'internal.judged' })
    doc.content.types[0].behavior.edges.push({ id: 'be_emit', from: 'b_start', to: 'b_emit' })
    expectIssue(doc, 'V4_UNKNOWN_EVENT')

    pushBehavior(doc, { id: 'b_on_internal', kind: 'on', event: 'internal.judged' })
    doc.content.types[0].behavior.edges.push({ id: 'be_int', from: 'b_on_internal', to: 'b_return' })
    expectNoIssue(doc, 'V4_UNKNOWN_EVENT')
  })
})

describe('v4 lint：绑定路径', () => {
  it('surface 绑定 q.ghost → V4_EXPR_PATH；shell 绑定 v.ghost 同理', () => {
    const surface = minimalLevelDoc()
    surface.content.types[0].surface.components[1].bindings = { options: 'q.ghost' }
    expectIssue(surface, 'V4_EXPR_PATH')

    const shell = minimalLevelDoc()
    shell.content.shell.components[0].bindings = { text: 'v.ghost' }
    expectIssue(shell, 'V4_EXPR_PATH')
  })

  it('surface 绑定使用 event 根被拒（根集合不含 event）', () => {
    const doc = minimalLevelDoc()
    doc.content.types[0].surface.components[0].bindings = { text: 'event.name' }
    expectIssue(doc, 'V4_EXPR_ROOT')
  })
})
