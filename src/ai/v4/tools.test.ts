// @vitest-environment jsdom
/**
 * v4 按层 AI 工具测试（W8.3 DoD）：
 * - 读工具：read_doc / read_layer（各层 + 错误层）/ read_run_log / lint；
 * - 写工具：七件套正向（经 loadLevelDocV4 预检后 applyDoc 落地）；
 * - 反向：非法写入被校验拒绝、悬空引用拒绝、未知题型/行/组件中文可读；
 * - revision 冲突门：run 期间用户手改 → 拒绝并回「先读后写」，重读后可重试；
 * - run_level 无头自验证：自动牌堆逐题返回 / score / passed / 注入事件 / seed 复现。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import type { BehaviorProgram, GraphEdge, LevelDocV4 } from '../../engine/v4/model'
import { loadLevelDocV4 } from '../../library/validate'
import { appendRunLog, clearRunLog } from '../../runtime/runLog'
import {
  V4_READ_TOOLS,
  V4_REVISION_CONFLICT,
  V4_WRITE_TOOLS,
  createRevisionGuard,
  getV4Tools,
  type AiToolV4,
  type V4ToolContext,
} from './tools'

const ALL_TOOLS: AiToolV4[] = [...V4_READ_TOOLS, ...V4_WRITE_TOOLS]

function tool(name: string): AiToolV4 {
  const found = ALL_TOOLS.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`测试找不到工具 ${name}`)
  return found
}

async function exec(name: string, args: Record<string, unknown>, ctx: V4ToolContext): Promise<string> {
  return await tool(name).exec(args, ctx)
}

interface Harness {
  ctx: V4ToolContext
  readonly doc: LevelDocV4
  readonly revision: number
  readonly applied: LevelDocV4[]
  /** 模拟创作者手动编辑：换文档 + revision 自增（与 EditorPageV4.update 同语义） */
  userEdit(mutate: (doc: LevelDocV4) => LevelDocV4): void
  /** 安装 run 级 revision 冲突门（run 起点 = 当前 revision） */
  installGuard(): void
}

function makeHarness(initial: LevelDocV4 = minimalLevelDoc(), levelId = 'test-level'): Harness {
  let doc = initial
  let revision = 1
  const applied: LevelDocV4[] = []
  const ctx: V4ToolContext = {
    getDoc: () => doc,
    applyDoc: (next) => {
      applied.push(next)
      doc = next
      revision += 1
    },
    getRevision: () => revision,
    levelId,
  }
  return {
    ctx,
    get doc() {
      return doc
    },
    get revision() {
      return revision
    },
    applied,
    userEdit(mutate) {
      doc = mutate(doc)
      revision += 1
    },
    installGuard() {
      ctx.revisionGuard = createRevisionGuard({ getRevision: () => revision })
    },
  }
}

beforeEach(() => {
  clearRunLog('test-level')
  clearRunLog('run-level')
})

// ---------------------------------------------------------------------------
// 读工具
// ---------------------------------------------------------------------------

describe('v4 读工具', () => {
  it('read_doc：输出分层摘要 + 题型/舞台/题单/流程 + 组件类型目录', async () => {
    const h = makeHarness()
    const text = await exec('read_doc', {}, h.ctx)
    expect(text).toContain('v4 测试关卡')
    expect(text).toContain('## 题型（1）')
    expect(text).toContain('choice（听音选择）')
    expect(text).toContain('## 舞台 shell')
    expect(text).toContain('## 主流程 flow')
    expect(text).toContain('## 可用组件类型')
    expect(text).toContain('label（')
    expect(text).toContain('read_layer')
  })

  it('read_layer：各层 JSON 可读；behavior 需 typeId；未知层/题型回中文错误', async () => {
    const h = makeHarness()
    const flow = await exec('read_layer', { layer: 'flow' }, h.ctx)
    expect(flow).toContain('"kind": "flow"')
    expect(flow).toContain('f_start')

    const types = await exec('read_layer', { layer: 'types', typeId: 'choice' }, h.ctx)
    expect(types).toContain('"surface"')
    expect(types).toContain('b_start')

    const tables = await exec('read_layer', { layer: 'tables' }, h.ctx)
    expect(tables).toContain('row_01')

    const manifest = await exec('read_layer', { layer: 'manifest' }, h.ctx)
    expect(manifest).toContain('"run"')
    expect(manifest).toContain('"auto": true')

    const shell = await exec('read_layer', { layer: 'shell' }, h.ctx)
    expect(shell).toContain('scoreLabel')

    const level = await exec('read_layer', { layer: 'level' }, h.ctx)
    expect(level).toContain('"schemaVersion": 4')

    const behavior = await exec('read_layer', { layer: 'behavior', typeId: 'choice' }, h.ctx)
    expect(behavior).toContain('"kind": "behavior"')

    // docs/51 §5.3 的 behavior:<typeId> 简写同样可用（无需额外 typeId 参数）
    const behaviorInline = await exec('read_layer', { layer: 'behavior:choice' }, h.ctx)
    expect(behaviorInline).toContain('"kind": "behavior"')
    expect(behaviorInline).toContain('b_start')

    expect(await exec('read_layer', { layer: 'behavior' }, h.ctx)).toContain('需要 typeId')
    expect(await exec('read_layer', { layer: 'nope' }, h.ctx)).toContain('未知层')
    expect(await exec('read_layer', { layer: 'tables', typeId: 'missing' }, h.ctx)).toContain('题型 "missing" 不存在')
  })

  it('read_run_log：无日志给提示；有日志按最近条目输出错误与节点 id', async () => {
    const h = makeHarness(minimalLevelDoc(), 'run-level')
    expect(await exec('read_run_log', {}, h.ctx)).toContain('暂无试运行日志')
    appendRunLog('run-level', { kind: 'error', message: '流程在 3000ms 内未结束', nodeId: 'f_ask', t: 1 })
    const text = await exec('read_run_log', {}, h.ctx)
    expect(text).toContain('[错误]')
    expect(text).toContain('节点 f_ask')
    expect(text).toContain('未结束')
  })

  it('lint：合法文档通过；结构损坏文档回错误清单（可读中文）', async () => {
    const h = makeHarness()
    expect(await exec('lint', {}, h.ctx)).toContain('校验通过')

    const broken = minimalLevelDoc()
    broken.content.shell.views.push({ id: 'main' }) // 视图 id 重复
    const h2 = makeHarness(broken)
    const text = await exec('lint', {}, h2.ctx)
    expect(text).toContain('校验失败')
    expect(text).toContain('重复')
  })
})

// ---------------------------------------------------------------------------
// 写工具（正向）
// ---------------------------------------------------------------------------

describe('v4 写工具：正向管线（mutate → loadLevelDocV4 预检 → applyDoc）', () => {
  it('edit_meta：写入后文档合法且摘要可读', async () => {
    const h = makeHarness()
    const result = await exec('edit_meta', { patch: { title: 'AI 新标题', description: 'AI 说明' } }, h.ctx)
    expect(result).toContain('✓')
    expect(result).toContain('AI 新标题')
    expect(h.doc.meta.title).toBe('AI 新标题')
    expect(h.doc.meta.description).toBe('AI 说明')
    expect(h.applied).toHaveLength(1)
    expect(loadLevelDocV4(h.doc).ok).toBe(true)
  })

  it('edit_table：add_rows 自动生成行 id、写入单元格/元数据；update_rows 只改给出字段', async () => {
    const h = makeHarness()
    const added = await exec(
      'edit_table',
      {
        op: 'add_rows',
        typeId: 'choice',
        rows: [{ prompt: '新题', options: ['Do', 'Mi'], scoring: 20, phase: 2 }],
      },
      h.ctx,
    )
    expect(added).toContain('✓')
    expect(added).toContain('行 id')
    const rows = h.doc.content.tables.choice.rows
    expect(rows).toHaveLength(4)
    const created = rows[rows.length - 1]
    expect(created.id).toMatch(/^row_/)
    expect(created.prompt).toBe('新题')
    expect(created.scoring).toBe(20)
    expect(created.phase).toBe(2)

    const updated = await exec(
      'edit_table',
      { op: 'update_rows', typeId: 'choice', rows: [{ id: created.id, scoring: 30 }] },
      h.ctx,
    )
    expect(updated).toContain('✓')
    const after = h.doc.content.tables.choice.rows.find((row) => row.id === created.id)
    expect(after?.scoring).toBe(30)
    expect(after?.prompt).toBe('新题') // 未给出的字段保留
  })

  it('edit_table：列操作（新增/改名/删除）与 remove_rows', async () => {
    const h = makeHarness()
    expect(await exec('edit_table', { op: 'add_column', typeId: 'choice', column: { key: 'hint', label: '提示', type: 'text' } }, h.ctx)).toContain('新增列 hint')
    expect(h.doc.content.tables.choice.columns.some((column) => column.key === 'hint')).toBe(true)

    expect(await exec('edit_table', { op: 'update_column', typeId: 'choice', column: { key: 'hint', newKey: 'tip' } }, h.ctx)).toContain('改名为 tip')
    expect(h.doc.content.tables.choice.columns.some((column) => column.key === 'tip')).toBe(true)

    expect(await exec('edit_table', { op: 'remove_rows', typeId: 'choice', ids: ['row_02'] }, h.ctx)).toContain('删除 1 行')
    expect(h.doc.content.tables.choice.rows.map((row) => row.id)).toEqual(['row_01', 'row_03'])

    expect(await exec('edit_table', { op: 'remove_column', typeId: 'choice', column: { key: 'tip' } }, h.ctx)).toContain('删除列 tip')
    expect(h.doc.content.tables.choice.columns.some((column) => column.key === 'tip')).toBe(false)
  })

  it('edit_types：新增题型（同步建空表）→ 改名 → 删除（级联清理表与题单）', async () => {
    const h = makeHarness()
    const added = await exec('edit_types', { op: 'add', type: { name: '新题型' } }, h.ctx)
    expect(added).toContain('✓')
    expect(h.doc.content.types).toHaveLength(2)
    const newType = h.doc.content.types[1]
    expect(newType.name).toBe('新题型')
    expect(h.doc.content.tables[newType.id]).toEqual({ columns: [], rows: [] })

    expect(await exec('edit_types', { op: 'update', typeId: newType.id, type: { name: '改名题型' } }, h.ctx)).toContain('改名题型')
    expect(h.doc.content.types[1].name).toBe('改名题型')

    expect(await exec('edit_types', { op: 'remove', typeId: newType.id }, h.ctx)).toContain('已删除')
    expect(h.doc.content.types).toHaveLength(1)
    expect(h.doc.content.tables[newType.id]).toBeUndefined()
  })

  it('edit_manifest：set/append/run/auto 全链路', async () => {
    const h = makeHarness()
    expect(
      await exec('edit_manifest', { op: 'set', entries: [{ type: 'choice', row: 'row_01' }] }, h.ctx),
    ).toContain('显式题单已设为 1 项')
    expect(h.doc.content.manifest?.entries).toEqual([{ type: 'choice', row: 'row_01' }])

    expect(
      await exec('edit_manifest', { op: 'append', entries: [{ type: 'choice', row: 'row_02', args: { difficulty: 2 } }] }, h.ctx),
    ).toContain('追加后为 2 项')
    expect(h.doc.content.manifest?.entries).toHaveLength(2)

    expect(await exec('edit_manifest', { op: 'run', run: { order: 'shuffle', seed: 42 } }, h.ctx)).toContain('seed=42')
    expect(h.doc.content.run.order).toBe('shuffle')
    expect(h.doc.content.run.seed).toBe(42)

    expect(await exec('edit_manifest', { op: 'auto' }, h.ctx)).toContain('自动题单')
    expect(h.doc.content.manifest).toBeUndefined()
  })

  it('edit_flow：整体替换主流程（保留 run 变量）', async () => {
    const h = makeHarness()
    const flow = h.doc.content.flow
    const result = await exec(
      'edit_flow',
      {
        nodes: [
          { id: 'f_start', kind: 'start' },
          { id: 'f_init', kind: 'assign', target: 'v.score', value: { expr: '5' } },
          { id: 'f_finish', kind: 'finish', passed: 'v.score >= 5' },
        ],
        edges: [
          { id: 'fe_1', from: 'f_start', to: 'f_init' },
          { id: 'fe_2', from: 'f_init', to: 'f_finish' },
        ],
      },
      h.ctx,
    )
    expect(result).toContain('✓')
    expect(h.doc.content.flow.nodes).toHaveLength(3)
    expect(h.doc.content.flow.vars).toEqual(flow.vars) // vars 省略 = 保留
  })

  it('edit_behavior：整体替换题型行为图（保留 locals 或缺省）', async () => {
    const h = makeHarness()
    const behavior: BehaviorProgram = {
      logicVersion: 3,
      kind: 'behavior',
      nodes: [
        { id: 'b_on', kind: 'on', event: 'start' },
        { id: 'b_ret', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: 5 }" },
      ],
      edges: [{ id: 'be_1', from: 'b_on', to: 'b_ret' }],
    }
    const result = await exec('edit_behavior', { typeId: 'choice', ...behavior }, h.ctx)
    expect(result).toContain('✓')
    expect(h.doc.content.types[0].behavior.nodes).toHaveLength(2)
    expect(h.doc.content.types[0].behavior.nodes.some((node) => node.kind === 'return')).toBe(true)
  })

  it('edit_shell：组件/视图增改删与 initialView', async () => {
    const h = makeHarness()
    const added = await exec(
      'edit_shell',
      {
        op: 'add_component',
        component: {
          type: 'label',
          name: '提示',
          view: 'main',
          layout: { x: 10, y: 10, w: 200, h: 40 },
          props: { text: '你好' },
          bindings: { text: "'得分: ' + v.score" },
        },
      },
      h.ctx,
    )
    expect(added).toContain('✓')
    expect(h.doc.content.shell.components).toHaveLength(2)
    const created = h.doc.content.shell.components[1]
    expect(created.type).toBe('label')
    expect(created.props).toEqual({ text: '你好' })
    expect(created.bindings).toEqual({ text: "'得分: ' + v.score" })

    expect(
      await exec('edit_shell', { op: 'update_component', componentId: created.id, component: { props: { text: '改过' } } }, h.ctx),
    ).toContain('✓')
    expect(h.doc.content.shell.components[1].props).toEqual({ text: '改过' })

    expect(await exec('edit_shell', { op: 'add_view', view: { name: '结算页' } }, h.ctx)).toContain('新增视图')
    expect(h.doc.content.shell.views).toHaveLength(2)
    const viewId = h.doc.content.shell.views[1].id

    expect(await exec('edit_shell', { op: 'set_initial_view', viewId }, h.ctx)).toContain('✓')
    expect(h.doc.content.shell.initialView).toBe(viewId)

    expect(await exec('edit_shell', { op: 'remove_view', viewId }, h.ctx)).toContain('已删除')
    expect(h.doc.content.shell.views).toHaveLength(1)

    expect(await exec('edit_shell', { op: 'remove_component', componentId: created.id }, h.ctx)).toContain('✓')
    expect(h.doc.content.shell.components).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 写工具（反向：非法写入 / 悬空引用 / 未知目标）
// ---------------------------------------------------------------------------

describe('v4 写工具：非法写入一律拒绝且不落盘', () => {
  it('edit_meta：title 为空被校验拒绝（含中文错误）', async () => {
    const h = makeHarness()
    const result = await exec('edit_meta', { patch: { title: '' } }, h.ctx)
    expect(result).toContain('修改被校验拒绝（未应用）')
    expect(result).toContain('title')
    expect(h.applied).toHaveLength(0)
    expect(h.doc.meta.title).toBe('v4 测试关卡')
  })

  it('edit_table：未知内容列拒绝并列出可用列', async () => {
    const h = makeHarness()
    const result = await exec('edit_table', { op: 'add_rows', typeId: 'choice', rows: [{ nope: 1 }] }, h.ctx)
    expect(result).toContain('修改失败（未应用）')
    expect(result).toContain('内容列 "nope" 不存在')
    expect(result).toContain('prompt')
    expect(h.applied).toHaveLength(0)
  })

  it('edit_table：未知题型 / 不存在的行 / 删除悬空行都回读得懂的错误', async () => {
    const h = makeHarness()
    expect(await exec('edit_table', { op: 'add_rows', typeId: 'missing', rows: [{ a: 1 }] }, h.ctx)).toContain('题型 "missing" 不存在')
    expect(await exec('edit_table', { op: 'update_rows', typeId: 'choice', rows: [{ id: 'row_x', prompt: 'x' }] }, h.ctx)).toContain('行 "row_x" 不存在')
    expect(await exec('edit_table', { op: 'remove_rows', typeId: 'choice', ids: ['row_x'] }, h.ctx)).toContain('不存在')
    expect(h.applied).toHaveLength(0)
  })

  it('edit_manifest：悬空引用（不存在的行/题型）被引用校验拒绝', async () => {
    const h = makeHarness()
    const badRow = await exec('edit_manifest', { op: 'set', entries: [{ type: 'choice', row: 'row_404' }] }, h.ctx)
    expect(badRow).toContain('修改被校验拒绝（未应用）')
    expect(badRow).toContain('不存在')
    expect(h.applied).toHaveLength(0)

    const badType = await exec('edit_manifest', { op: 'set', entries: [{ type: 'missing', row: 'row_01' }] }, h.ctx)
    expect(badType).toContain('修改被校验拒绝（未应用）')
    expect(badType).toContain('题型')
    expect(h.applied).toHaveLength(0)
  })

  it('edit_flow：连线悬空 / 双 start 被校验拒绝', async () => {
    const h = makeHarness()
    const dangling = await exec(
      'edit_flow',
      {
        nodes: [
          { id: 'f_start', kind: 'start' },
          { id: 'f_finish', kind: 'finish' },
        ],
        edges: [{ id: 'fe_1', from: 'f_start', to: 'f_missing' }],
      },
      h.ctx,
    )
    expect(dangling).toContain('修改被校验拒绝（未应用）')
    expect(dangling).toContain('f_missing')
    expect(h.applied).toHaveLength(0)

    const twoStarts = await exec(
      'edit_flow',
      {
        nodes: [
          { id: 'f_start', kind: 'start' },
          { id: 'f_start2', kind: 'start' },
        ],
        edges: [],
      },
      h.ctx,
    )
    expect(twoStarts).toContain('修改被校验拒绝（未应用）')
    expect(h.applied).toHaveLength(0)
  })

  it('edit_behavior：未知题型回中文错误；无 return 的行为图被 lint/校验拒绝', async () => {
    const h = makeHarness()
    expect(
      await exec('edit_behavior', { typeId: 'missing', nodes: [], edges: [] }, h.ctx),
    ).toContain('题型 "missing" 不存在')
    expect(h.applied).toHaveLength(0)

    const noStart = await exec(
      'edit_behavior',
      {
        typeId: 'choice',
        nodes: [{ id: 'b_ret', kind: 'return', result: '{}' }],
        edges: [],
      },
      h.ctx,
    )
    expect(noStart).toContain('修改被校验拒绝（未应用）')
    expect(noStart).toContain('on start')
    expect(h.applied).toHaveLength(0)
  })

  it('edit_shell：未知组件/视图、非法视图整体替换都被拒绝', async () => {
    const h = makeHarness()
    expect(await exec('edit_shell', { op: 'remove_component', componentId: 'nope' }, h.ctx)).toContain('不存在')
    expect(await exec('edit_shell', { op: 'remove_view', viewId: 'nope' }, h.ctx)).toContain('不存在')
    expect(await exec('edit_shell', { op: 'add_component', component: { view: 'main' } }, h.ctx)).toContain('component.type 不能为空')
    expect(await exec('edit_shell', { op: 'replace', shell: { views: [] } }, h.ctx)).toContain('至少需要一个视图')
    expect(h.applied).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// revision 冲突门
// ---------------------------------------------------------------------------

describe('v4 revision 冲突门（run 期间用户手改 → 先读后写）', () => {
  it('冲突拒绝且不落盘；重读后可在新状态上重试成功', async () => {
    const h = makeHarness()
    h.installGuard() // run 起点 revision = 1
    h.userEdit((doc) => ({ ...doc, meta: { ...doc.meta, title: '用户手改的标题' } }))

    const rejected = await exec('edit_meta', { patch: { title: 'AI 想改的标题' } }, h.ctx)
    expect(rejected).toBe(V4_REVISION_CONFLICT)
    expect(rejected).toContain('先读后写')
    expect(h.applied).toHaveLength(0)
    expect(h.doc.meta.title).toBe('用户手改的标题')

    // 「先读」：模型重新读取现状（读工具不经过写管线，不触发冲突）
    const state = await exec('read_layer', { layer: 'level' }, h.ctx)
    expect(state).toContain('用户手改的标题')

    // 冲突后基准已推进：重试成功
    const retried = await exec('edit_meta', { patch: { title: 'AI 新标题' } }, h.ctx)
    expect(retried).toContain('✓')
    expect(h.doc.meta.title).toBe('AI 新标题')
    expect(h.applied).toHaveLength(1)
  })

  it('无冲突时连续多次写入都成功（同 run 内基准随写入推进）', async () => {
    const h = makeHarness()
    h.installGuard()
    expect(await exec('edit_meta', { patch: { title: '一' } }, h.ctx)).toContain('✓')
    expect(await exec('edit_meta', { patch: { title: '二' } }, h.ctx)).toContain('✓')
    expect(h.doc.meta.title).toBe('二')
    expect(h.applied).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// run_level 无头自验证
// ---------------------------------------------------------------------------

/** 可无头通关的 v4 文档：行为 start→return（按 q.scoring 计分），流程 foreach 逐题 ask 累计 v.score */
function runnableDoc(): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.content.types[0].behavior = {
    logicVersion: 3,
    kind: 'behavior',
    nodes: [
      { id: 'b_start', kind: 'on', event: 'start' },
      { id: 'b_ret', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: q.scoring }" },
    ],
    edges: [{ id: 'be_1', from: 'b_start', to: 'b_ret' }],
  }
  const out = (from: string, to: string, port?: 'true' | 'false'): GraphEdge => ({
    id: `e_${from}_${to}_${port ?? 'out'}`,
    from,
    to,
    ...(port ? { port } : {}),
  })
  doc.content.flow = {
    logicVersion: 3,
    kind: 'flow',
    nodes: [
      { id: 'f_start', kind: 'start' },
      { id: 'f_foreach', kind: 'foreach', items: 'run.questions', itemVar: 'slot' },
      { id: 'f_ask', kind: 'ask', target: 'local.slot', resultVar: 'result' },
      { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'v.score + local.result.scoreDelta' } },
      { id: 'f_finish', kind: 'finish', passed: 'v.score >= 20' },
    ],
    edges: [
      out('f_start', 'f_foreach'),
      out('f_foreach', 'f_ask', 'true'),
      out('f_foreach', 'f_finish', 'false'),
      out('f_ask', 'f_apply'),
      out('f_apply', 'f_foreach'),
    ],
    vars: [{ key: 'score', type: 'number', init: 0 }],
  }
  return doc
}

describe('v4 run_level：无头自验证', () => {
  it('自动牌堆逐题返回 → score/passed/每题记录/牌堆/日志齐全', async () => {
    const h = makeHarness(runnableDoc(), 'run-level')
    const text = await exec('run_level', {}, h.ctx)
    expect(text).toContain('✓ 流程已结束')
    expect(text).toContain('score=20 passed=true')
    expect(text).toContain('【每题返回】')
    expect(text).toContain('choice/row_01')
    expect(text).toContain('scoreDelta=10')
    expect(text).toContain('【牌堆】2 题')
    expect(text).toContain('【运行日志】无错误/警告')
  })

  it('固定 seed 可复现；events 简写可注入作答', async () => {
    const h = makeHarness(runnableDoc(), 'run-level')
    const seeded = await exec('run_level', { seed: 7 }, h.ctx)
    expect(seeded).toContain('seed=7')

    // 交互型行为：等 surface 事件后再 return（events 简写自动等题目出现）
    const interactive = runnableDoc()
    interactive.content.types[0].behavior = {
      logicVersion: 3,
      kind: 'behavior',
      nodes: [
        { id: 'b_start', kind: 'on', event: 'start' },
        { id: 'b_on', kind: 'on', event: 'choice1.chosen' },
        { id: 'b_ret', kind: 'return', result: '{ scoreDelta: event.payload.score }' },
      ],
      edges: [{ id: 'be_1', from: 'b_on', to: 'b_ret' }],
    }
    const i = makeHarness(interactive, 'run-level')
    const eventsText = await exec(
      'run_level',
      {
        events: [
          // 第一题作答后留一点处理时间，等下一题 surface 出现再投第二个事件（避免事件落到已返回的调用上）
          { event: 'choice1.chosen', payload: { score: 10 }, waitMs: 120 },
          { event: 'choice1.chosen', payload: { score: 10 } },
        ],
      },
      i.ctx,
    )
    expect(eventsText).toContain('score=20 passed=true')
    expect(eventsText).toContain('answered')
  })

  it('events 格式错误 / 流程卡死 / 文档未过校验都回可读中文（不抛异常）', async () => {
    const h = makeHarness(runnableDoc(), 'run-level')
    const malformed = await exec('run_level', { events: [{ payload: {} }] }, h.ctx)
    expect(malformed).toContain('运行失败（未执行）')
    expect(malformed).toContain('event')

    // 结构损坏的文档：先回装载错误，不硬跑
    const broken = runnableDoc()
    broken.content.shell.components.push({ ...broken.content.shell.components[0] })
    const b = makeHarness(broken, 'run-level')
    const invalidDoc = await exec('run_level', {}, b.ctx)
    expect(invalidDoc).toContain('运行失败（未执行）')
    expect(invalidDoc).toContain('未通过校验')

    const stuck = runnableDoc()
    stuck.content.types[0].behavior = {
      logicVersion: 3,
      kind: 'behavior',
      nodes: [
        { id: 'b_start', kind: 'on', event: 'start' },
        { id: 'b_wait', kind: 'wait', ms: '5000' },
        { id: 'b_ret', kind: 'return', result: '{}' },
      ],
      edges: [
        { id: 'be_1', from: 'b_start', to: 'b_wait' },
        { id: 'be_2', from: 'b_wait', to: 'b_ret' },
      ],
    }
    const s = makeHarness(stuck, 'run-level')
    const timeoutText = await exec('run_level', { timeoutMs: 120 }, s.ctx)
    expect(timeoutText).toContain('流程未在')
    expect(timeoutText).toContain('未结束')
  })

  it('写完立刻 run_level 自验证：edit_behavior 把计分改成 5 → score 变化可观察', async () => {
    const h = makeHarness(runnableDoc(), 'run-level')
    const before = await exec('run_level', {}, h.ctx)
    expect(before).toContain('score=20 passed=true')

    const write = await exec(
      'edit_behavior',
      {
        typeId: 'choice',
        nodes: [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_ret', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: 5 }" },
        ],
        edges: [{ id: 'be_1', from: 'b_start', to: 'b_ret' }],
      },
      h.ctx,
    )
    expect(write).toContain('✓')

    const after = await exec('run_level', {}, h.ctx)
    expect(after).toContain('score=10 passed=false')
  })
})

// ---------------------------------------------------------------------------
// 工具集按模式裁剪
// ---------------------------------------------------------------------------

describe('v4 工具集按模式裁剪', () => {
  it('ask 只有读工具；agent = 读 + 七件套写工具', () => {
    const askNames = getV4Tools('ask').map((item) => item.name)
    expect(askNames).toContain('read_doc')
    expect(askNames).toContain('run_level')
    expect(askNames).not.toContain('edit_meta')
    expect(askNames).not.toContain('edit_flow')

    const agentNames = getV4Tools('agent').map((item) => item.name)
    for (const name of [
      'edit_meta',
      'edit_types',
      'edit_table',
      'edit_manifest',
      'edit_flow',
      'edit_behavior',
      'edit_shell',
    ]) {
      expect(agentNames).toContain(name)
    }
  })
})
