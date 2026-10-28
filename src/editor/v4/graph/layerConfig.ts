/**
 * v4 图工作台「层配置」：调色板候选、事件候选、组件契约查询、作用域根。
 *
 * 设计目标（docs/53 §13.4）：
 * - 调色板按层给出**可插入的节点**（默认值取合法形态，插入即尽量零 lint 错）；
 * - behavior 的 `on` 入口候选由「题型 surface 组件事件 + start + internal.*」自动生成
 *   （docs/52 W6.3），不要求作者手打事件名；
 * - 组件契约（events/commands/queries）从 runtime/store 只读查询，供检查器下拉与 lint 注入；
 * - 全部是纯函数（doc 引用稳定时结果稳定），不持有状态。
 */
import type { Json } from '../../../engine/expr'
import type { BehaviorProgram, FlowProgram, LevelDocV4 } from '../../../engine/v4/model'
import { getType } from '../../../engine/v4/model'
import { BEHAVIOR_ROOTS, FLOW_ROOTS } from '../../../engine/v4/expr'
import type { ContractDoc } from '../../../runtime/componentDef'
import { BASE_COMMANDS } from '../../../runtime/componentDef'
import { allContracts } from '../../../runtime/store'
import type { AnyGraphNode, GraphLayer } from './ops'

export type ContractInfo = Pick<ContractDoc, 'events' | 'commands' | 'queries'>

/** 组件类型 → 契约（模块级一次构建；未知类型返回 undefined，不触发 runtime 告警） */
const CONTRACTS: Map<string, ContractInfo> = new Map(
  allContracts().map((contract) => [contract.type, { events: contract.events, commands: contract.commands, queries: contract.queries }]),
)

export function contractOfType(componentType: string): ContractInfo | undefined {
  return CONTRACTS.get(componentType)
}

/** 层允许的表达式根（检查器实时校验 / 提示用） */
export function layerRoots(layer: GraphLayer): readonly string[] {
  return layer === 'flow' ? FLOW_ROOTS : BEHAVIOR_ROOTS
}

/** 层允许的表达式根（中文提示：flow v/local/run；behavior q/q.state/t/args/local/v/run/event） */
export function layerRootHint(layer: GraphLayer): string {
  return layer === 'flow' ? 'v.（run 变量）/ local.（调用局部）/ run.（运行时只读）' : 'q. / q.state. / t. / args. / local. / v. / run. / event.（仅事件链）'
}

/** js 表达式校验选项（allowV4Functions 仅 flow 层：stateOf/contentOf） */
export function exprCheckOptions(layer: GraphLayer): { roots: readonly string[]; allowV4Functions: boolean } {
  return { roots: layerRoots(layer), allowV4Functions: layer === 'flow' }
}

// ---------------------------------------------------------------------------
// 组件清单（shell / 题型 surface）
// ---------------------------------------------------------------------------

export interface ComponentInfo {
  id: string
  type: string
  name?: string
}

export function shellComponents(doc: LevelDocV4): ComponentInfo[] {
  return doc.content.shell.components.map((component) => ({ id: component.id, type: component.type, name: component.name }))
}

export function surfaceComponents(doc: LevelDocV4, typeId: string | undefined): ComponentInfo[] {
  if (typeId === undefined) return []
  const type = getType(doc, typeId)
  return (type?.surface.components ?? []).map((component) => ({ id: component.id, type: component.type, name: component.name }))
}

/** 题型内视图（v4.1）：行为层 setView 的候选；无题内视图时返回空数组 */
export function surfaceViews(doc: LevelDocV4, typeId: string | undefined): { id: string; name?: string }[] {
  if (typeId === undefined) return []
  return (getType(doc, typeId)?.surface.views ?? []).map((view) => ({ id: view.id, name: view.name }))
}

/** 组件命令候选（契约命令 + 基座命令，去重；不含 `__` 内部命令） */
export function componentCommands(componentType: string): { name: string; doc?: string }[] {
  const contract = contractOfType(componentType)
  const own = Object.entries(contract?.commands ?? {})
    .filter(([name]) => !name.startsWith('__'))
    .map(([name, doc]) => ({ name, doc }))
  const declared = new Set(own.map((item) => item.name))
  const base = [...BASE_COMMANDS].filter((name) => !declared.has(name)).map((name) => ({ name }))
  return [...own, ...base]
}

/** 组件查询候选（assign 右侧 query 用） */
export function componentQueries(componentType: string): string[] {
  return Object.keys(contractOfType(componentType)?.queries ?? {})
}

export function componentEvents(componentType: string): Record<string, string> {
  return contractOfType(componentType)?.events ?? {}
}

// ---------------------------------------------------------------------------
// 事件候选（behavior on 入口 / flow waitShell）
// ---------------------------------------------------------------------------

export interface EventCandidate {
  group: string
  value: string
  label: string
  desc?: string
}

/** 行为程序里已出现的内部事件（emit 节点声明处） */
export function collectInternalEvents(program: BehaviorProgram): string[] {
  const events = new Set<string>()
  for (const node of program.nodes) {
    if (node.kind === 'emit' && node.event.startsWith('internal.')) events.add(node.event)
  }
  return [...events]
}

/** behavior `on` 事件候选：start + 本题 surface 组件事件 + 已声明的 internal.* */
export function onEventCandidates(
  doc: LevelDocV4,
  typeId: string | undefined,
  program: BehaviorProgram,
): EventCandidate[] {
  const candidates: EventCandidate[] = [
    { group: '系统事件', value: 'start', label: '开始（start）', desc: '每次 ask 调用开始时派发一次' },
  ]
  const surface = surfaceComponents(doc, typeId)
  const internals = collectInternalEvents(program)
  if (internals.length > 0) {
    candidates.push(
      ...internals.map((event) => ({ group: '内部事件', value: event, label: event, desc: '由 emit 节点派发' })),
    )
  }
  const componentItems: EventCandidate[] = []
  for (const component of surface) {
    const events = componentEvents(component.type)
    for (const [eventName, payloadDoc] of Object.entries(events)) {
      const label = `${component.name?.trim() || component.id} · ${eventName}`
      componentItems.push({
        group: '组件事件',
        value: `${component.id}.${eventName}`,
        label,
        desc: payloadDoc !== '' ? `负载：${payloadDoc}` : undefined,
      })
    }
  }
  if (componentItems.length > 0) candidates.push(...componentItems)
  return candidates
}

/** flow `waitShell` 事件候选：shell 组件的契约事件 */
export function shellEventCandidates(doc: LevelDocV4): EventCandidate[] {
  const out: EventCandidate[] = []
  for (const component of shellComponents(doc)) {
    const events = componentEvents(component.type)
    for (const [eventName, payloadDoc] of Object.entries(events)) {
      out.push({
        group: component.name?.trim() || component.id,
        value: `${component.id}.${eventName}`,
        label: `${component.name?.trim() || component.id} · ${eventName}`,
        desc: payloadDoc !== '' ? `负载：${payloadDoc}` : undefined,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 调色板
// ---------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 节点形状（不含 id；id 由 GraphWorkbench 程序化补齐） */
export type GraphNodeShape = DistributiveOmit<AnyGraphNode, 'id'>

export interface PaletteItem {
  key: string
  label: string
  desc: string
  make(pos?: { x: number; y: number }): GraphNodeShape
}

export interface PaletteGroup {
  id: string
  label: string
  hint: string
  items: PaletteItem[]
}

const at = (pos?: { x: number; y: number }): { x?: number; y?: number } => (pos ? { x: pos.x, y: pos.y } : {})

function firstCommand(componentType: string | undefined): string {
  if (componentType === undefined) return 'setVisible'
  return componentCommands(componentType)[0]?.name ?? 'setVisible'
}

function firstQuery(componentType: string | undefined): string {
  if (componentType === undefined) return 'getValue'
  return componentQueries(componentType)[0] ?? 'getValue'
}

function firstView(doc: LevelDocV4): string {
  return doc.content.shell.views[0]?.id ?? 'main'
}

/** behavior foreach 默认遍历表达式：优先取该题型表里的 list/json/notes 列（数组），无则空数组字面量 */
function defaultBehaviorItems(doc: LevelDocV4, typeId: string | undefined): string {
  if (typeId === undefined) return '[]'
  const columns = doc.content.tables[typeId]?.columns ?? []
  const column = columns.find((item) => item.type === 'list' || item.type === 'json' || item.type === 'notes')
  return column ? `q.${column.key}` : '[]'
}

export function defaultFlowAssignTarget(program: FlowProgram): string {
  const declared = program.vars ?? []
  return declared.length > 0 ? `v.${declared[0].key}` : 'v.score'
}

export function defaultBehaviorAssignTarget(
  doc: LevelDocV4,
  typeId: string | undefined,
  program: BehaviorProgram,
): string {
  const type = typeId !== undefined ? getType(doc, typeId) : undefined
  if (type?.state !== undefined && type.state.length > 0) return `q.state.${type.state[0].key}`
  if (type?.typeState !== undefined && type.typeState.length > 0) return `t.${type.typeState[0].key}`
  const locals = program.locals ?? []
  if (locals.length > 0) return `local.${locals[0].key}`
  return 'q.state.answered'
}

/** flow 调色板（docs/52 W6.2 节点目录） */
export function buildFlowPalette(doc: LevelDocV4, program: FlowProgram): PaletteGroup[] {
  const hasStart = program.nodes.some((node) => node.kind === 'start')
  const shell = shellComponents(doc)
  const firstShell = shell[0]
  const waits = shellEventCandidates(doc)
  const groups: PaletteGroup[] = []

  if (!hasStart) {
    groups.push({
      id: 'entry',
      label: '入口',
      hint: '流程图必须且只有一个 start 节点',
      items: [{ key: 'flow-start', label: '开始 start', desc: '流程唯一入口（无入边）', make: (pos) => ({ kind: 'start', ...at(pos) }) }],
    })
  }

  groups.push(
    {
      id: 'assign',
      label: '赋值',
      hint: '写 run 变量 v.* 或调用局部 local.*',
      items: [
        {
          key: 'flow-assign',
          label: '赋值 v./local.',
          desc: '给已声明变量或局部变量赋值（右侧可写表达式或组件查询）',
          make: (pos) => ({ kind: 'assign', target: defaultFlowAssignTarget(program), value: { expr: '0' }, ...at(pos) }),
        },
        {
          key: 'flow-assign-query',
          label: '赋值 ← 组件查询',
          desc: `读取组件状态写回变量（如 ${firstShell?.id ?? 'slider1'}.getValue()）`,
          make: (pos) => ({
            kind: 'assign',
            target: defaultFlowAssignTarget(program),
            value: {
              query: firstShell !== undefined ? { target: firstShell.id, method: firstQuery(firstShell.type) } : { target: 'slider1', method: 'getValue' },
            },
            ...at(pos),
          }),
        },
      ],
    },
    {
      id: 'action',
      label: '动作',
      hint: '调用 shell 组件的命令（组件与命令在检查器选择）',
      items: [
        {
          key: 'flow-call',
          label: '组件动作 call',
          desc: '调用 shell 组件命令（如 sound.play / label.setText）',
          make: (pos) => ({
            kind: 'call',
            target: firstShell?.id ?? 'missing_component',
            method: firstCommand(firstShell?.type),
            ...at(pos),
          }),
        },
      ],
    },
    {
      id: 'view',
      label: '视图',
      hint: '切换 shell 视图',
      items: [
        {
          key: 'flow-setview',
          label: '切换视图 view',
          desc: '切换 shell 当前视图（立即生效）',
          make: (pos) => ({ kind: 'setView', view: firstView(doc), ...at(pos) }),
        },
      ],
    },
    {
      id: 'ask',
      label: '提问',
      hint: '调用题型函数并挂起等待（返回 QuestionResult）',
      items: [
        {
          key: 'flow-ask',
          label: '提问 ask',
          desc: '调用题型函数（结果写入 local.<结果变量>，流程挂起等待）',
          make: (pos) => ({ kind: 'ask', target: 'run.questions[0]', resultVar: 'result', ...at(pos) }),
        },
      ],
    },
    {
      id: 'control',
      label: '控制流',
      hint: '分支 / 循环（真出口走体，假出口走后续）',
      items: [
        { key: 'flow-branch', label: '条件分支 if', desc: '条件为真走「真」出口，否则走「假」出口', make: (pos) => ({ kind: 'branch', cond: 'true', ...at(pos) }) },
        { key: 'flow-repeat', label: '固定次数循环 repeat', desc: '重复执行循环体 N 次（体尾需回到循环头）', make: (pos) => ({ kind: 'loop', mode: 'repeat', times: '2', ...at(pos) }) },
        { key: 'flow-while', label: '条件循环 while', desc: '条件为真时重复执行循环体（体尾需回到循环头）', make: (pos) => ({ kind: 'loop', mode: 'while', cond: 'false', ...at(pos) }) },
        { key: 'flow-foreach', label: '遍历 foreach', desc: '顺序遍历数组，每次迭代写入局部变量', make: (pos) => ({ kind: 'foreach', items: 'run.questions', itemVar: 'slot', ...at(pos) }) },
      ],
    },
    {
      id: 'wait',
      label: '等待',
      hint: '定时等待 / 等待 shell 事件',
      items: [
        { key: 'flow-wait', label: '等待 wait', desc: '休眠指定毫秒（可被取消）', make: (pos) => ({ kind: 'wait', ms: '300', ...at(pos) }) },
        ...(waits.length > 0
          ? [
              {
                key: 'flow-waitshell',
                label: '等待组件事件 waitShell',
                desc: '挂起等待 shell 组件事件（结算后展示期间常用）',
                make: (pos) => ({ kind: 'waitShell', event: waits[0].value, ...at(pos) }),
              } satisfies PaletteItem,
            ]
          : []),
      ],
    },
    {
      id: 'settle',
      label: '结算',
      hint: '结算（幂等）与重开',
      items: [
        { key: 'flow-finish', label: '结算 finish', desc: '记录结算（passed 可写表达式；缺省视为 true）', make: (pos) => ({ kind: 'finish', ...at(pos) }) },
        { key: 'flow-finish-passed', label: '结算（带通过条件）', desc: '按表达式判定是否通过', make: (pos) => ({ kind: 'finish', passed: 'v.score >= 60', ...at(pos) }) },
        { key: 'flow-restart', label: '重开 restart', desc: '终止当前 run 并重新开始（无出边）', make: (pos) => ({ kind: 'restart', ...at(pos) }) },
      ],
    },
    {
      id: 'comment',
      label: '注释',
      hint: '不参与执行，不能接线',
      items: [{ key: 'flow-comment', label: '注释 comment', desc: '画布说明（不参与执行）', make: (pos) => ({ kind: 'comment', text: '说明…', ...at(pos) }) }],
    },
  )
  return groups
}

/** behavior 调色板（docs/52 W6.3 节点目录 + surface 事件自动入口） */
export function buildBehaviorPalette(
  doc: LevelDocV4,
  typeId: string | undefined,
  program: BehaviorProgram,
): PaletteGroup[] {
  const surface = surfaceComponents(doc, typeId)
  const firstSurface = surface[0]
  const views = surfaceViews(doc, typeId)
  const events = onEventCandidates(doc, typeId, program)
  const eventItems: PaletteItem[] = events.map((candidate) => ({
    key: `on-${candidate.value.replace(/[^A-Za-z0-9_-]/g, '-')}`,
    label: candidate.label,
    desc: candidate.desc ?? `${candidate.value} 事件入口`,
    make: (pos) => ({ kind: 'on', event: candidate.value, ...at(pos) }),
  }))
  eventItems.push({
    key: 'on-custom',
    label: '自定义事件入口…',
    desc: '插入 on 节点后在检查器选择/输入事件名（如 internal.newEvent）',
    make: (pos) => ({ kind: 'on', event: 'internal.newEvent', ...at(pos) }),
  })
  return [
    {
      id: 'events',
      label: '事件入口',
      hint: '题型 surface 组件事件 / start / internal.*（可多个 handler 并存）',
      items: eventItems,
    },
    {
      id: 'action',
      label: '动作',
      hint: '调用本题 surface 组件的命令',
      items: [
        {
          key: 'behavior-call',
          label: '组件动作 call',
          desc: '调用 surface 组件命令（只能作用于本题 surface 组件）',
          make: (pos) => ({
            kind: 'call',
            target: firstSurface?.id ?? 'missing_component',
            method: firstCommand(firstSurface?.type),
            ...at(pos),
          }),
        },
        {
          key: 'behavior-emit',
          label: '派发内部事件 emit',
          desc: '派发 internal.<名字> 事件（排队，不中断当前链）',
          make: (pos) => ({ kind: 'emit', event: 'internal.event', ...at(pos) }),
        },
      ],
    },
    {
      id: 'assign',
      label: '赋值',
      hint: '写 q.state.* / t.* / local.*',
      items: [
        {
          key: 'behavior-assign',
          label: '赋值',
          desc: '写实例态 q.state.* / 题型态 t.* / 局部 local.*',
          make: (pos) => ({ kind: 'assign', target: defaultBehaviorAssignTarget(doc, typeId, program), value: { expr: '0' }, ...at(pos) }),
        },
      ],
    },
    {
      id: 'control',
      label: '控制流',
      hint: '分支 / 循环 / 遍历（真出口走体，假出口走后续）',
      items: [
        { key: 'behavior-branch', label: '条件分支 if', desc: '条件为真走「真」出口，否则走「假」出口', make: (pos) => ({ kind: 'branch', cond: 'true', ...at(pos) }) },
        { key: 'behavior-repeat', label: '固定次数循环 repeat', desc: '重复执行循环体 N 次', make: (pos) => ({ kind: 'loop', mode: 'repeat', times: '2', ...at(pos) }) },
        { key: 'behavior-while', label: '条件循环 while', desc: '条件为真时重复执行循环体', make: (pos) => ({ kind: 'loop', mode: 'while', cond: 'false', ...at(pos) }) },
        {
          key: 'behavior-foreach',
          label: '遍历 foreach',
          desc: '顺序遍历数组，每次迭代把元素/下标写入 local（如逐音比较、逐项判分）',
          make: (pos) => ({ kind: 'foreach', items: defaultBehaviorItems(doc, typeId), itemVar: 'item', indexVar: 'index', ...at(pos) }),
        },
      ],
    },
    {
      id: 'return',
      label: '返回与等待',
      hint: 'return 结束本次调用（首个生效）',
      items: [
        {
          key: 'behavior-return',
          label: '返回 return',
          desc: '返回 QuestionResult（表达式 → 对象），结束本次调用',
          make: (pos) => ({ kind: 'return', result: "{ status: 'answered' }", ...at(pos) }),
        },
        { key: 'behavior-wait', label: '等待 wait', desc: '休眠指定毫秒（任务内顺序执行）', make: (pos) => ({ kind: 'wait', ms: '200', ...at(pos) }) },
      ],
    },
    ...(views.length > 0
      ? [
          {
            id: 'view',
            label: '题内视图',
            hint: '切换题型内部视图（只过滤渲染，组件状态保留）',
            items: [
              {
                key: 'behavior-setview',
                label: '切换视图 view',
                desc: '切换到题型内已声明的视图（如 读题 → 作答 → 反馈）',
                make: (pos): GraphNodeShape => ({ kind: 'setView', view: views[0].id, ...at(pos) }),
              } satisfies PaletteItem,
            ],
          } satisfies PaletteGroup,
        ]
      : []),
    {
      id: 'comment',
      label: '注释',
      hint: '不参与执行，不能接线',
      items: [{ key: 'behavior-comment', label: '注释 comment', desc: '画布说明（不参与执行）', make: (pos) => ({ kind: 'comment', text: '说明…', ...at(pos) }) }],
    },
  ]
}

/** JSON 初值编辑：空文本 = null；否则 JSON.parse（检查器就地报错） */
export function parseInitJson(text: string): { ok: true; value: Json } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(trimmed) as Json }
  } catch {
    return { ok: false, error: '不是合法 JSON' }
  }
}
