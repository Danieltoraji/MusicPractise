/**
 * v4 语义 lint（docs/53 §12 的语义层）：表达式根/路径/写权限、组件契约（命令/查询/事件）、
 * 图可达性、finish 之后的节点限制、未结算流程、行为无 return、内部事件配对、绑定路径。
 *
 * 与 validate.ts 分工：validate 拦截「文档坏了」；lint 报告「能打开但运行会出问题」的语义问题
 * （error 级也只在装载管线里作为 lintWarnings 返回，编辑器可打开修复——与 v3 口径一致）。
 *
 * 组件契约通过 ctx.contractOf 注入（引擎层不反向依赖 runtime/store）：
 * 宿主/装载管线传 `allContracts()` 的映射；缺省时跳过契约相关检查。
 */
import type { ContractDoc } from '../../runtime/componentDef'
import { parseExpr } from '../expr'
import {
  FLOW_ROOTS,
  SHELL_BINDING_ROOTS,
  SURFACE_BINDING_ROOTS,
  checkV4Expr,
  collectExprPaths,
  validateWriteTarget,
} from './expr'
import type { BehaviorProgram, ComponentInstanceV4, FlowNode, FlowProgram, LevelDocV4 } from './model'
import { getTable } from './model'
import type { V4Issue } from './validate'

/** 与 runtime/componentDef BASE_COMMANDS 同步的基座命令（lint 不反向依赖 runtime 运行时值） */
const BASE_COMMANDS_FALLBACK = ['setVisible', 'setEnabled'] as const

export interface V4LintCtx {
  /** 组件类型 → 契约（events/commands/queries）；缺省跳过契约检查 */
  contractOf?: (componentType: string) => Pick<ContractDoc, 'events' | 'commands' | 'queries'> | undefined
}

type Lint = {
  issues: V4Issue[]
}

function error(lint: Lint, code: string, message: string, extra: Omit<V4Issue, 'code' | 'level' | 'message'> = {}): void {
  lint.issues.push({ code, level: 'error', message, ...extra })
}

function warn(lint: Lint, code: string, message: string, extra: Omit<V4Issue, 'code' | 'level' | 'message'> = {}): void {
  lint.issues.push({ code, level: 'warning', message, ...extra })
}

const RUN_READ_KEYS = new Set(['questions', 'total', 'seed', 'index'])
const EVENT_READ_KEYS = new Set(['name', 'payload'])

// ---------------------------------------------------------------------------
// 作用域（静态可见字段集合）
// ---------------------------------------------------------------------------

interface ExprScopeInfo {
  roots: readonly string[]
  allowV4Functions: boolean
  allowEvent: boolean
  /** v.* 可读集合（flow.vars 声明） */
  vars: Set<string>
  /** local.* 可读集合 */
  locals: Set<string>
  qColumns: Set<string>
  qState: Set<string>
  typeState: Set<string>
  args: Set<string>
}

function emptyScope(roots: readonly string[], allowV4Functions: boolean, allowEvent: boolean): ExprScopeInfo {
  return {
    roots,
    allowV4Functions,
    allowEvent,
    vars: new Set(),
    locals: new Set(),
    qColumns: new Set(),
    qState: new Set(),
    typeState: new Set(),
    args: new Set(),
  }
}

/** flow 隐式局部变量：ask.resultVar / foreach.itemVar|indexVar / assign→local.* */
function collectFlowImplicitLocals(program: FlowProgram): Set<string> {
  const locals = new Set<string>()
  for (const node of program.nodes) {
    if (node.kind === 'ask') locals.add(node.resultVar)
    else if (node.kind === 'foreach') {
      locals.add(node.itemVar)
      if (node.indexVar) locals.add(node.indexVar)
    } else if (node.kind === 'assign' && node.target.startsWith('local.')) {
      locals.add(node.target.slice('local.'.length))
    }
  }
  return locals
}

/** 路径静态校验：根已由 checkV4Expr 校验，这里查字段是否存在 */
function checkPathParts(parts: string[], scope: ExprScopeInfo): string | null {
  const [root, ...rest] = parts
  if (rest.length === 0) return null
  const head = rest[0]
  switch (root) {
    case 'run':
      return RUN_READ_KEYS.has(head)
        ? null
        : `未知的运行时字段 "run.${head}"（可用：questions/total/seed/index）`
    case 'event':
      if (!scope.allowEvent) return `"event" 只能用于行为事件处理链`
      return EVENT_READ_KEYS.has(head) ? null : `未知的事件字段 "event.${head}"（可用：name/payload）`
    case 'q':
      if (head === 'id') return null
      if (head === 'state') {
        if (rest.length === 1) return null
        return scope.qState.has(rest[1]) ? null : `未声明的实例态字段 "q.state.${rest[1]}"`
      }
      return scope.qColumns.has(head) ? null : `内容列 "q.${head}" 未在实例表中声明`
    case 't':
      return scope.typeState.has(head) ? null : `未声明的题型态字段 "t.${head}"`
    case 'args':
      return scope.args.has(head) ? null : `未声明的调用参数 "args.${head}"`
    case 'v':
      return scope.vars.has(head) ? null : `未声明的 run 变量 "v.${head}"`
    case 'local':
      return scope.locals.has(head) ? null : `未声明的局部变量 "local.${head}"`
    default:
      return null
  }
}

interface ExprExtra {
  nodeId?: string
  typeId?: string
  rowId?: string
  path?: string
}

const EXPR_CODE: Record<'syntax' | 'root' | 'function', string> = {
  syntax: 'V4_EXPR_SYNTAX',
  root: 'V4_EXPR_ROOT',
  function: 'V4_EXPR_SYNTAX',
}

function checkExpr(
  lint: Lint,
  scope: ExprScopeInfo,
  text: unknown,
  where: string,
  extra: ExprExtra = {},
): void {
  if (typeof text !== 'string' || text.trim() === '') return
  const checked = checkV4Expr(text, { roots: scope.roots, allowV4Functions: scope.allowV4Functions })
  if (!checked.ok) {
    error(lint, EXPR_CODE[checked.code], `${where}：${checked.message}`, extra)
    return
  }
  let ast
  try {
    ast = parseExpr(text)
  } catch {
    return
  }
  for (const parts of collectExprPaths(ast)) {
    const problem = checkPathParts(parts, scope)
    if (problem) error(lint, 'V4_EXPR_PATH', `${where}：${problem}`, extra)
  }
}

// ---------------------------------------------------------------------------
// 组件契约：命令/查询/事件
// ---------------------------------------------------------------------------

interface ComponentIndex {
  /** 组件 id → 组件类型（按层） */
  byId: Map<string, string>
}

function indexComponents(components: ComponentInstanceV4[]): ComponentIndex {
  return { byId: new Map(components.map((c) => [c.id, c.type])) }
}

const BASE_COMMAND_SET: Set<string> = new Set(BASE_COMMANDS_FALLBACK)

function checkCommand(
  lint: Lint,
  ctx: V4LintCtx,
  index: ComponentIndex,
  layer: 'shell' | 'surface',
  nodeId: string,
  target: unknown,
  method: unknown,
  extra: ExprExtra,
): void {
  if (typeof target !== 'string' || typeof method !== 'string') return
  const type = index.byId.get(target)
  if (!type) return // 引用存在性已由 validate 拦截
  const contract = ctx.contractOf?.(type)
  if (!contract) return
  if (contract.commands[method] !== undefined || BASE_COMMAND_SET.has(method)) return
  error(
    lint,
    'V4_UNKNOWN_METHOD',
    `节点「${nodeId}」调用了 ${layer === 'shell' ? 'shell' : 'surface'} 组件「${target}」（类型 ${type}）未声明的命令 "${method}"`,
    { ...extra, nodeId },
  )
}

function checkQuery(
  lint: Lint,
  ctx: V4LintCtx,
  index: ComponentIndex,
  nodeId: string,
  target: unknown,
  method: unknown,
  extra: ExprExtra,
): void {
  if (typeof target !== 'string' || typeof method !== 'string') return
  const type = index.byId.get(target)
  if (!type) return
  const contract = ctx.contractOf?.(type)
  if (!contract) return
  if (contract.queries && contract.queries[method] !== undefined) return
  error(lint, 'V4_UNKNOWN_METHOD', `节点「${nodeId}」查询了组件「${target}」（类型 ${type}）未声明的查询 "${method}"`, {
    ...extra,
    nodeId,
  })
}

/** 组件事件 `comp.event`：组件存在 + 契约声明了该事件 */
function checkComponentEvent(
  lint: Lint,
  ctx: V4LintCtx,
  index: ComponentIndex,
  layer: 'shell' | 'surface',
  event: unknown,
  where: string,
  extra: ExprExtra,
): void {
  if (typeof event !== 'string') return
  const dot = event.indexOf('.')
  if (dot <= 0) return
  const compId = event.slice(0, dot)
  const eventName = event.slice(dot + 1)
  const type = index.byId.get(compId)
  if (!type) return // validate 已报未知组件
  const contract = ctx.contractOf?.(type)
  if (!contract) return
  if (contract.events[eventName] !== undefined) return
  error(
    lint,
    'V4_UNKNOWN_EVENT',
    `${where}引用了${layer === 'shell' ? ' shell' : ' surface'} 组件「${compId}」（类型 ${type}）未声明的事件 "${eventName}"`,
    extra,
  )
}

// ---------------------------------------------------------------------------
// 图可达性
// ---------------------------------------------------------------------------

function adjacency(program: FlowProgram | BehaviorProgram): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const edge of program.edges) {
    const list = out.get(edge.from)
    if (list) list.push(edge.to)
    else out.set(edge.from, [edge.to])
  }
  return out
}

function reachableFrom(adj: Map<string, string[]>, starts: string[]): Set<string> {
  const seen = new Set<string>()
  const stack = [...starts]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of adj.get(id) ?? []) stack.push(next)
  }
  return seen
}

// ---------------------------------------------------------------------------
// Flow lint
// ---------------------------------------------------------------------------

const FINISH_AFTER_ALLOWED = new Set(['call', 'setView', 'waitShell', 'wait', 'restart', 'comment'])

function makeFlowNodeExtra(node: FlowNode): ExprExtra {
  return { nodeId: node.id }
}

function lintFlowProgram(
  lint: Lint,
  ctx: V4LintCtx,
  program: FlowProgram,
  scope: ExprScopeInfo,
  shellIndex: ComponentIndex,
): void {
  const adj = adjacency(program)
  const starts = program.nodes.filter((n) => n.kind === 'start').map((n) => n.id)
  const reachable = reachableFrom(adj, starts)
  for (const node of program.nodes) {
    if (node.kind === 'comment') continue
    if (!reachable.has(node.id)) {
      warn(lint, 'V4_UNREACHABLE', `流程节点「${node.id}」（${node.kind}）从 start 不可达，不会执行`, {
        nodeId: node.id,
      })
    }
  }
  // 未结算的结束路径
  const ends = program.nodes.filter(
    (n) => n.kind !== 'comment' && reachable.has(n.id) && (adj.get(n.id)?.length ?? 0) === 0,
  )
  const unsettled = ends.filter((n) => n.kind !== 'finish' && n.kind !== 'restart')
  if (unsettled.length > 0) {
    warn(
      lint,
      'V4_UNSETTLED_FLOW',
      `流程存在未结算的结束路径（结束于 ${unsettled.map((n) => `「${n.id}」`).join('、')}）：运行到此会结束关卡但不产生结算`,
    )
  }
  // finish 之后只允许 shell 操作/waitShell/restart/comment
  for (const finish of program.nodes.filter((n) => n.kind === 'finish')) {
    const after = reachableFrom(adj, adj.get(finish.id) ?? [])
    const allowed = program.nodes.filter((n) => after.has(n.id) && !FINISH_AFTER_ALLOWED.has(n.kind))
    for (const node of allowed) {
      error(
        lint,
        'V4_ASK_AFTER_FINISH',
        `节点「${node.id}」（${node.kind}）位于 finish「${finish.id}」之后：结算后只允许 shell 命令/setView/waitShell/wait/restart/comment`,
        { nodeId: node.id },
      )
    }
  }
  // 表达式 + 写权限 + 契约
  for (const node of program.nodes) {
    const extra = makeFlowNodeExtra(node)
    switch (node.kind) {
      case 'assign': {
        const deny = validateWriteTarget(node.target, 'flow', {
          vars: [...scope.vars],
          locals: [...scope.locals],
        })
        if (deny) error(lint, 'V4_WRITE_DENIED', `流程节点「${node.id}」赋值目标非法：${deny}`, extra)
        checkRValue(lint, ctx, shellIndex, scope, node.value, `流程节点「${node.id}」value`, extra)
        break
      }
      case 'call':
        checkExpr(lint, scope, node.arg, `流程节点「${node.id}」arg`, extra)
        checkCommand(lint, ctx, shellIndex, 'shell', node.id, node.target, node.method, extra)
        break
      case 'ask':
        checkExpr(lint, scope, node.target, `流程节点「${node.id}」target`, extra)
        checkExpr(lint, scope, node.args, `流程节点「${node.id}」args`, extra)
        break
      case 'foreach':
        checkExpr(lint, scope, node.items, `流程节点「${node.id}」items`, extra)
        break
      case 'branch':
        checkExpr(lint, scope, node.cond, `流程节点「${node.id}」cond`, extra)
        break
      case 'loop':
        checkExpr(lint, scope, node.cond, `流程节点「${node.id}」cond`, extra)
        checkExpr(lint, scope, node.times, `流程节点「${node.id}」times`, extra)
        break
      case 'wait':
        checkExpr(lint, scope, node.ms, `流程节点「${node.id}」ms`, extra)
        break
      case 'finish':
        checkExpr(lint, scope, node.passed, `流程节点「${node.id}」passed`, extra)
        break
      case 'waitShell':
        checkComponentEvent(lint, ctx, shellIndex, 'shell', node.event, `流程节点「${node.id}」waitShell `, extra)
        break
      default:
        break
    }
  }
}

function checkRValue(
  lint: Lint,
  ctx: V4LintCtx,
  index: ComponentIndex,
  scope: ExprScopeInfo,
  value: unknown,
  where: string,
  extra: ExprExtra,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  const expr = record.expr
  if (typeof expr === 'string') {
    checkExpr(lint, scope, expr, where)
    return
  }
  const query = record.query
  if (query !== null && typeof query === 'object' && !Array.isArray(query)) {
    const q = query as Record<string, unknown>
    checkExpr(lint, scope, q.arg, `${where} 查询参数`, extra)
    checkQuery(lint, ctx, index, extra.nodeId ?? '（节点）', q.target, q.method, extra)
  }
}

// ---------------------------------------------------------------------------
// Behavior lint
// ---------------------------------------------------------------------------

function lintBehaviorProgram(
  lint: Lint,
  ctx: V4LintCtx,
  program: BehaviorProgram,
  scope: ExprScopeInfo,
  surfaceIndex: ComponentIndex,
  typeId: string,
): void {
  const adj = adjacency(program)
  const entries = program.nodes.filter((n) => n.kind === 'on').map((n) => n.id)
  const reachable = reachableFrom(adj, entries)
  for (const node of program.nodes) {
    if (node.kind === 'comment') continue
    if (!reachable.has(node.id)) {
      warn(lint, 'V4_UNREACHABLE', `题型 "${typeId}" 的行为节点「${node.id}」（${node.kind}）从任何 on 入口不可达`, {
        nodeId: node.id,
        typeId,
      })
    }
  }
  const returns = new Set(program.nodes.filter((n) => n.kind === 'return').map((n) => n.id))
  for (const on of program.nodes.filter((n) => n.kind === 'on')) {
    const fromHandler = reachableFrom(adj, [on.id])
    if (![...returns].some((id) => fromHandler.has(id))) {
      warn(
        lint,
        'V4_BEHAVIOR_NO_RETURN',
        `题型 "${typeId}" 的事件「${on.event}」无法到达 return：该调用只能靠 watchdog 结束`,
        { nodeId: on.id, typeId },
      )
    }
  }
  // 内部事件配对
  const emitted = new Set<string>()
  const handled = new Set<string>()
  for (const node of program.nodes) {
    if (node.kind === 'emit') {
      emitted.add(node.event)
      if (node.payload) {
        for (const [key, expr] of Object.entries(node.payload)) {
          checkExpr(lint, scope, expr, `行为节点「${node.id}」payload.${key}`, { nodeId: node.id, typeId })
        }
      }
    } else if (node.kind === 'on' && node.event.startsWith('internal.')) {
      handled.add(node.event)
    }
  }
  for (const event of emitted) {
    if (!handled.has(event)) {
      warn(lint, 'V4_UNKNOWN_EVENT', `题型 "${typeId}" 的内部事件 "${event}" 没有对应的 on 处理器`, { typeId })
    }
  }
  for (const event of handled) {
    if (!emitted.has(event)) {
      warn(lint, 'V4_UNKNOWN_EVENT', `题型 "${typeId}" 的 on "${event}" 不会被触发（没有任何 emit 该事件）`, { typeId })
    }
  }
  // 表达式 + 写权限 + 契约
  for (const node of program.nodes) {
    const extra: ExprExtra = { nodeId: node.id, typeId }
    switch (node.kind) {
      case 'assign': {
        const deny = validateWriteTarget(node.target, 'behavior', {
          vars: [...scope.vars],
          locals: [...scope.locals],
          qState: [...scope.qState],
          typeState: [...scope.typeState],
        })
        if (deny) error(lint, 'V4_WRITE_DENIED', `行为节点「${node.id}」赋值目标非法：${deny}`, extra)
        checkRValue(lint, ctx, surfaceIndex, scope, node.value, `行为节点「${node.id}」value`, extra)
        break
      }
      case 'call':
        checkExpr(lint, scope, node.arg, `行为节点「${node.id}」arg`, extra)
        checkCommand(lint, ctx, surfaceIndex, 'surface', node.id, node.target, node.method, extra)
        break
      case 'return':
        checkExpr(lint, scope, node.result, `行为节点「${node.id}」result`, extra)
        break
      case 'branch':
        checkExpr(lint, scope, node.cond, `行为节点「${node.id}」cond`, extra)
        break
      case 'loop':
        checkExpr(lint, scope, node.cond, `行为节点「${node.id}」cond`, extra)
        checkExpr(lint, scope, node.times, `行为节点「${node.id}」times`, extra)
        break
      case 'wait':
        checkExpr(lint, scope, node.ms, `行为节点「${node.id}」ms`, extra)
        break
      case 'on':
        if (!node.event.startsWith('internal.') && node.event !== 'start') {
          checkComponentEvent(lint, ctx, surfaceIndex, 'surface', node.event, `题型 "${typeId}" 的 on `, extra)
        }
        break
      default:
        break
    }
  }
}

// ---------------------------------------------------------------------------
// 绑定表达式 lint（路径/契约之外的语义；根与语法已由 validate 拦截）
// ---------------------------------------------------------------------------

function lintBindings(
  lint: Lint,
  components: ComponentInstanceV4[],
  scope: ExprScopeInfo,
  layerLabel: string,
  typeId?: string,
): void {
  for (const comp of components) {
    if (!comp.bindings) continue
    for (const [slot, expr] of Object.entries(comp.bindings)) {
      checkExpr(lint, scope, expr, `${layerLabel}组件「${comp.id}」绑定 "${slot}"`, {
        typeId,
        path: `components.${comp.id}.bindings.${slot}`,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * v4 语义 lint。返回 issues（level 只有 error/warning 两种）；
 * 装载管线把 error 与 warning 统一作为 lintWarnings（可打开修复）。
 */
export function lintLevelDocV4(doc: LevelDocV4, ctx: V4LintCtx = {}): V4Issue[] {
  const lint: Lint = { issues: [] }
  const content = doc.content
  const flowVars = new Set((content.flow.vars ?? []).map((f) => f.key))
  const shellIndex = indexComponents(content.shell.components)
  const shellScope = emptyScope(SHELL_BINDING_ROOTS, false, false)
  shellScope.vars = new Set(flowVars)
  lintBindings(lint, content.shell.components, shellScope, 'shell ')

  const flowScope = emptyScope(FLOW_ROOTS, true, false)
  flowScope.vars = new Set(flowVars)
  flowScope.locals = collectFlowImplicitLocals(content.flow)
  lintFlowProgram(lint, ctx, content.flow, flowScope, shellIndex)

  for (const type of content.types) {
    const table = getTable(doc, type.id)
    const surfaceIndex = indexComponents(type.surface.components)
    const scope = emptyScope(
      ['q', 't', 'local', 'args', 'v', 'run', 'event'] as const,
      false,
      true,
    )
    scope.vars = new Set(flowVars)
    scope.locals = new Set((type.behavior.locals ?? []).map((f) => f.key))
    scope.qColumns = new Set((table?.columns ?? []).map((c) => c.key))
    scope.qState = new Set((type.state ?? []).map((f) => f.key))
    scope.typeState = new Set((type.typeState ?? []).map((f) => f.key))
    scope.args = new Set((type.args ?? []).map((f) => f.key))
    lintBehaviorProgram(lint, ctx, type.behavior, scope, surfaceIndex, type.id)

    const bindingScope: ExprScopeInfo = {
      ...scope,
      roots: SURFACE_BINDING_ROOTS,
      allowEvent: false,
      locals: new Set(),
    }
    lintBindings(lint, type.surface.components, bindingScope, `题型 "${type.id}" 的 surface `, type.id)
  }
  return lint.issues
}
