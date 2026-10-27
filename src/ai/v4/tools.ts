/**
 * v4 AI 按层工具（W8.3 / docs/52 W8.3、docs/51 §5.3）。
 *
 * 设计要点：
 * - **按层读写**：v4 文档 = meta + shell / types / tables / manifest+run / flow / behavior；
 *   读工具 `read_doc`（全局摘要）→ `read_layer`（单层完整内容），写工具一次只改一层
 *   （edit_meta / edit_types / edit_table / edit_manifest / edit_flow / edit_behavior / edit_shell）。
 * - **统一写管线 `applyAndCheckV4`**：revision 冲突门 → mutate（docStateV4 纯函数）→
 *   `loadLevelDocV4` 预检（结构 errors 拒绝、lintWarnings 附回）→ `ctx.applyDoc`。
 *   失败一律回喂可读中文（模型自纠），绝不静默落盘。
 * - **先读后写**：写入被误用/引用悬空/结构损坏时拒绝并提示先读该层再改；
 *   运行期间创作者手改过文档（revision 变化）同样拒绝，要求重新读取现状。
 * - 本模块不依赖 React / 编辑器宿主：宿主只提供 `getDoc / applyDoc / getRevision / levelId / signal`
 *   五个能力，因此可被 AiPanelV4、测试与后续无头 agent 复用。
 */
import type { Json } from '../../engine/expr'
import type { ColumnType } from '../../engine/level'
import {
  LOGIC_VERSION_V4,
  cloneLevelDocV4,
  getType,
  type BehaviorProgram,
  type ComponentInstanceV4,
  type FlowProgram,
  type LevelDocV4,
  type ManifestEntry,
  type QuestionRow,
  type QuestionTable,
  type QuestionTypeDef,
  type RunConfig,
} from '../../engine/v4/model'
import { loadLevelDocV4 } from '../../library/validate'
import { readRunLog } from '../../runtime/runLog'
import { allContracts } from '../../runtime/store'
import { runLevelHeadless, type HarnessStep } from '../../runtime/v4/harness'
import {
  SHELL_LAYER,
  addColumn,
  addComponent,
  addRow,
  addType,
  addView,
  moveRow,
  removeColumn,
  removeComponent,
  removeRow,
  removeType,
  removeView,
  renameColumn,
  setManifest,
  setRunConfig,
  updateBehavior,
  updateColumn,
  updateComponent,
  updateFlow,
  updateRowMeta,
  updateShell,
  updateTableCell,
  updateType,
  updateView,
  withMeta,
  type AddTypeSeed,
  type RowMetaPatch,
} from '../../editor/v4/docStateV4'

// ---------------------------------------------------------------------------
// 上下文与工具协议
// ---------------------------------------------------------------------------

/**
 * 运行内 revision 冲突门（agent 循环注入；工具单测可自行构造）：
 * - `expected()` = 本次 run 已确认的文档 revision（null = 关闭检测）；
 * - `accept()` = 一次 AI 写入成功落盘后，把基准推进到当前 revision；
 * - `rejected()` = 检测到运行期间手改：抛给宿主清理运行内影子副本（后续读工具改读实时文档）。
 */
export interface V4RevisionGuard {
  expected(): number | null
  accept(): void
  rejected?(): void
}

/** 宿主能力注入（与编辑器解耦：AiPanelV4 / 测试 / 后续无头 agent 均按此实现） */
export interface V4ToolContext {
  /** 读最新文档（agent 循环内应读到「本轮已应用」的影子副本） */
  getDoc(): LevelDocV4
  /** 应用修改（编辑器唯一写路径：入撤销栈 + 标脏 + revision 自增） */
  applyDoc(next: LevelDocV4): void
  /** 编辑器文档修订号（每次文档变更递增；冲突检测真源） */
  getRevision(): number
  /** 运行日志 / 关卡 id（read_run_log 用） */
  levelId: string
  /** 运行中止信号（长等待工具在等待点检查后提前收尾） */
  signal?: AbortSignal
  /** 本次 run 的 revision 冲突门（缺省 = 不做冲突检测，例如只读工具单测） */
  revisionGuard?: V4RevisionGuard
}

export interface AiToolV4 {
  name: string
  description: string
  /** JSON Schema parameters（与 v3 工具同风格） */
  parameters: Record<string, unknown>
  exec(args: Record<string, unknown>, ctx: V4ToolContext): string | Promise<string>
}

/** v4 读层标识：read_layer 的 layer 取值（behavior 需同时给 typeId） */
export const V4_READ_LAYERS = ['level', 'types', 'tables', 'manifest', 'flow', 'behavior', 'shell'] as const
export type V4ReadLayer = (typeof V4_READ_LAYERS)[number]

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const has = (o: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)
const json = (v: unknown): string => JSON.stringify(v, null, 2)

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 超长文本在行边界截断，并明确提示可继续分段读取（避免静默丢内容） */
function clipText(label: string, text: string, budget: number, hint: string): string {
  if (text.length <= budget) return text
  const tail = `\n…（${label}超长，已截断 ${text.length - budget} 字符；${hint}）`
  const room = Math.max(0, budget - tail.length)
  let head = text.slice(0, room)
  const nl = head.lastIndexOf('\n')
  if (nl > room * 0.6) head = head.slice(0, nl)
  return head + tail
}

function typeListText(doc: LevelDocV4): string {
  return doc.content.types.map((t) => `${t.id}（${t.name}）`).join('、') || '（无题型）'
}

function requireType(doc: LevelDocV4, typeId: string): QuestionTypeDef {
  const type = getType(doc, typeId)
  if (!type) throw new Error(`题型 "${typeId}" 不存在。现有题型：${typeListText(doc)}`)
  return type
}

function requireTable(doc: LevelDocV4, typeId: string): QuestionTable {
  requireType(doc, typeId)
  const table = doc.content.tables[typeId]
  if (!table) throw new Error(`题型 "${typeId}" 没有实例表（content.tables.${typeId}）`)
  return table
}

function assertColumnExists(table: QuestionTable, key: string): void {
  if (table.columns.some((c) => c.key === key)) return
  throw new Error(
    `内容列 "${key}" 不存在（列定义：${table.columns.map((c) => c.key).join('、') || '（空表）'}）` +
      '——新增列请先用 edit_table op=add_column',
  )
}

/** 把「cells 对象 + 行内其它标量键」归一成单元格 patch（行元数据 draft/phase/order 单独处理） */
const ROW_META_KEYS = ['draft', 'phase', 'order'] as const

function splitRowSpec(spec: Record<string, unknown>): { cells: Record<string, unknown>; meta: RowMetaPatch } {
  const cells: Record<string, unknown> = { ...obj(spec.cells ?? spec.values) }
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'cells' || key === 'values' || key === 'id') continue
    if ((ROW_META_KEYS as readonly string[]).includes(key)) continue
    cells[key] = value
  }
  const meta: RowMetaPatch = {}
  if (has(spec, 'draft')) meta.draft = spec.draft === null ? null : spec.draft === true
  if (has(spec, 'phase')) meta.phase = spec.phase === null ? null : num(spec.phase)
  if (has(spec, 'order')) meta.order = spec.order === null ? null : num(spec.order)
  return { cells, meta }
}

function manifestEntry(raw: unknown): ManifestEntry {
  const e = obj(raw)
  const type = str(e.type)
  const row = str(e.row)
  if (!type || !row) throw new Error('题单每项必须形如 { type: 题型id, row: 行id, args? }')
  const entry: ManifestEntry = { type, row }
  if (e.args !== undefined) entry.args = e.args as Json
  return entry
}

// ---------------------------------------------------------------------------
// 写管线：applyAndCheckV4
// ---------------------------------------------------------------------------

/** revision 冲突门拒绝文案（模型据此重读现状；测试按「先读后写」断言） */
export const V4_REVISION_CONFLICT =
  '写入被拒绝（未应用）：本次 AI 运行期间编辑器已被手动修改（run 起点 revision 与当前不一致）。' +
  '请先 read_doc / read_layer 重新读取现状，再基于新内容重写（先读后写）。'

/**
 * 构造运行级 revision 冲突门（agent 循环/宿主/测试共用）：
 * - 创建时记录当前 revision 作为「run 起点」；
 * - 每次 AI 写入成功后由 {@link applyAndCheckV4} 调 `accept()` 把基准推进到当前 revision；
 * - 检测到冲突时 `rejected()` 先推进基准（避免模型重读后仍被旧基准卡死），再回调宿主复位运行内影子副本。
 */
export function createRevisionGuard(options: {
  getRevision(): number
  onReject?(): void
}): V4RevisionGuard {
  let expected: number | null = options.getRevision()
  return {
    expected: () => expected,
    accept: () => {
      expected = options.getRevision()
    },
    rejected: () => {
      expected = options.getRevision()
      options.onReject?.()
    },
  }
}


/**
 * v4 统一写管线：冲突门 → mutate → loadLevelDocV4 预检 → applyDoc。
 * - mutate 只能使用 docStateV4 纯函数（恒返回新对象，禁原地 mutation）；
 * - 预检 errors 拒绝并回喂全部错误；lintWarnings 附在成功摘要后；
 * - 返回文本一律可读中文（成功以 ✓ 开头，失败以「修改…（未应用）」开头）。
 */
export function applyAndCheckV4(
  ctx: V4ToolContext,
  what: string | ((applied: LevelDocV4) => string),
  mutate: (doc: LevelDocV4) => LevelDocV4,
): string {
  // 1) revision 冲突门：run 期间用户手改过 → 拒绝，要求先读后写
  const guard = ctx.revisionGuard
  const expected = guard ? guard.expected() : null
  if (guard && expected !== null && ctx.getRevision() !== expected) {
    guard.rejected?.()
    return V4_REVISION_CONFLICT
  }

  // 2) mutate（docState 纯函数；抛错回喂可读原因）
  let next: LevelDocV4
  try {
    next = mutate(ctx.getDoc())
  } catch (err) {
    return `修改失败（未应用）：${err instanceof Error ? err.message : String(err)}`
  }
  if (next === ctx.getDoc()) {
    return '修改未应用：内容没有变化（目标值可能已相同）。可先 read_layer 确认现状。'
  }

  // 3) 预检：schema + 结构/引用 + 语义 lint（lint 作为警告附回，不阻断）
  let check: ReturnType<typeof loadLevelDocV4>
  try {
    check = loadLevelDocV4(cloneLevelDocV4(next))
  } catch (err) {
    return `修改被校验拒绝（未应用）：文档结构异常——${err instanceof Error ? err.message : String(err)}`
  }
  if (!check.ok) {
    return `修改被校验拒绝（未应用）——请按下列错误修正后重试：\n${check.errors.map((e) => `- ${e}`).join('\n')}`
  }

  // 4) 应用（编辑器唯一写路径；宿主异常同样回喂模型，不落盘）
  try {
    ctx.applyDoc(check.doc)
  } catch (err) {
    return `修改未被应用：${err instanceof Error ? err.message : String(err)}`
  }
  guard?.accept()

  const label = typeof what === 'function' ? what(check.doc) : what
  const warns =
    check.lintWarnings.length > 0
      ? `\n校验警告（${check.lintWarnings.length}）：${check.lintWarnings.slice(0, 12).join('；')}${
          check.lintWarnings.length > 12 ? ' …' : ''
        }`
      : ''
  return `✓ ${label}已应用。${warns}`
}

// ---------------------------------------------------------------------------
// 读工具
// ---------------------------------------------------------------------------

const MAX_DOC_CHARS = 9000
const MAX_LAYER_CHARS = 16000
const MAX_LOG_ENTRIES = 30
const MAX_RUN_LOGS = 18

/** 组件类型目录（契约清单）：让模型在 edit_shell/edit_types 里写 component.type 时不靠猜 */
function componentCatalogText(): string {
  const lines = allContracts().map((contract) => {
    const events = Object.keys(contract.events)
    const commands = Object.keys(contract.commands)
    const queries = Object.keys(contract.queries ?? {})
    const props = (contract.propsFields ?? []).map((f) => {
      const options = f.options && f.options.length > 0 ? `:${f.options.join('/')}` : ''
      return `${f.key}(${f.type}${options})`
    })
    const parts = [
      `事件 ${events.length > 0 ? events.join('/') : '无'}`,
      `命令 ${commands.length > 0 ? commands.join('/') : '无'}`,
      ...(queries.length > 0 ? [`查询 ${queries.join('/')}`] : []),
      ...(props.length > 0 ? [`props ${props.join(' ')}`] : []),
    ]
    return `- ${contract.type}（${contract.displayName}）：${parts.join('；')}`
  })
  return lines.join('\n')
}

const readDocTool: AiToolV4 = {
  name: 'read_doc',
  description:
    '读取当前 v4 关卡的全局摘要：meta、题型清单（行/列/state/args）、舞台视图与组件、题单（自动/显式）与 run 配置、' +
    '主流程概要与可用组件类型契约。看某一层的完整 JSON 用 read_layer（先读后写）；' +
    '写完后用 lint / run_level 自验证',
  parameters: { type: 'object', properties: {} },
  exec: (_args, ctx) => {
    const doc = ctx.getDoc()
    const lines: string[] = []
    lines.push(`# 关卡 ${str(doc.meta.title)}（id=${doc.id}，version=${doc.version}，schemaVersion=${doc.schemaVersion}）`)
    lines.push(`## meta\n${json(doc.meta)}`)

    const typeLines = doc.content.types.map((type) => {
      const table = doc.content.tables[type.id]
      const bits = [
        `${table?.rows.length ?? 0} 行 / ${table?.columns.length ?? 0} 列`,
        `surface 组件 ${type.surface.components.length} 个`,
        `行为节点 ${type.behavior.nodes.length} 个`,
      ]
      if (type.state?.length) bits.push(`state ${type.state.map((f) => f.key).join('/')}`)
      if (type.typeState?.length) bits.push(`typeState ${type.typeState.map((f) => f.key).join('/')}`)
      if (type.args?.length) bits.push(`args ${type.args.map((f) => f.key + (f.optional ? '?' : '')).join('/')}`)
      return `- ${type.id}（${type.name}）：${bits.join('；')}`
    })
    lines.push(`## 题型（${doc.content.types.length}）\n${typeLines.join('\n') || '（暂无题型）'}`)

    const shell = doc.content.shell
    lines.push(
      `## 舞台 shell\n- 视图：${shell.views.map((v) => `${v.id}${v.name ? `(${v.name})` : ''}`).join('、')}` +
        `\n- initialView：${shell.initialView ?? '（未设置，用首个视图）'}` +
        `\n- 组件 ${shell.components.length} 个：${
          shell.components.map((c) => `${c.id}:${c.type}@${c.view ?? '?'}`).join('、') || '（无）'
        }`,
    )

    const manifest = doc.content.manifest
    lines.push(
      `## 题单\n- ${
        manifest
          ? `显式题单 ${manifest.entries.length} 项：${manifest.entries
              .slice(0, 20)
              .map((e) => `${e.type}/${e.row}`)
              .join('、')}${manifest.entries.length > 20 ? ' …' : ''}`
          : '自动题单（未设显式 manifest；由 run 配置与各表 phase/order 生成）'
      }\n- run：order=${doc.content.run.order} count=${doc.content.run.count ?? 'null(全部)'} seed=${
        doc.content.run.seed ?? 'null(每局随机)'
      } shuffleWithinPhase=${doc.content.run.shuffleWithinPhase}`,
    )

    const flow = doc.content.flow
    lines.push(
      `## 主流程 flow\n- ${flow.nodes.length} 节点 / ${flow.edges.length} 连线；start 入口 ${
        flow.nodes.filter((n) => n.kind === 'start').length
      } 个` +
        `\n- run 变量：${
          flow.vars && flow.vars.length > 0 ? flow.vars.map((f) => `${f.key}(${f.type})`).join('、') : '（未声明）'
        }`,
    )

    lines.push(`## 可用组件类型（component.type）\n${componentCatalogText()}`)
    lines.push(
      '## 下一步\n用 read_layer 读取要修改的层：layer=level/types/tables/manifest/flow/shell（行为层用 layer=behavior 并给 typeId）；' +
        '写入后跑 lint 与 run_level 验证。',
    )
    return clipText('摘要', lines.join('\n\n'), MAX_DOC_CHARS, '请用 read_layer 分段读取具体层')
  },
}

/** read_layer 的层内容渲染（定位失败抛错，由 exec 归一为可读「读取失败」） */
function renderLayerText(doc: LevelDocV4, layer: string, typeId: string): string {
  const wrap = (label: string, value: unknown, hint: string): string =>
    clipText(label, json(value), MAX_LAYER_CHARS, hint)
  if (layer === 'level') {
    return wrap(
      'level 层',
      {
        schemaVersion: doc.schemaVersion,
        kind: doc.kind,
        id: doc.id,
        version: doc.version,
        meta: doc.meta,
        refs: doc.refs ?? [],
        content: {
          shell: { views: doc.content.shell.views, components: doc.content.shell.components.length },
          types: doc.content.types.map((t) => ({
            id: t.id,
            name: t.name,
            rows: doc.content.tables[t.id]?.rows.length ?? 0,
            columns: doc.content.tables[t.id]?.columns.length ?? 0,
          })),
          tables: Object.fromEntries(Object.entries(doc.content.tables).map(([id, t]) => [id, t.rows.length])),
          manifest: doc.content.manifest === undefined ? null : doc.content.manifest.entries.length,
          run: doc.content.run,
          flow: { nodes: doc.content.flow.nodes.length, edges: doc.content.flow.edges.length },
        },
      },
      '用 read_layer 的其他层读取完整内容',
    )
  }
  if (layer === 'types') {
    const types = typeId ? [requireType(doc, typeId)] : doc.content.types
    return wrap(
      typeId ? `题型 ${typeId}` : '题型层',
      types,
      typeId ? '内容过长时请精简该题型的 surface/behavior' : '可用 layer=types + typeId 逐个题型读取',
    )
  }
  if (layer === 'tables') {
    const tables = typeId ? { [typeId]: requireTable(doc, typeId) } : doc.content.tables
    return wrap(
      typeId ? `实例表 ${typeId}` : '实例表层',
      tables,
      typeId ? '内容过长时请分列/分行精简' : '可用 layer=tables + typeId 逐表读取',
    )
  }
  if (layer === 'behavior') {
    if (!typeId) throw new Error(`layer=behavior 需要 typeId。现有题型：${typeListText(doc)}`)
    const type = requireType(doc, typeId)
    // v4.1：行为层 setView 的目标是题内视图，读层时带 surface 视图上下文
    return wrap(
      `行为层 ${typeId}`,
      {
        surface: {
          views: type.surface.views ?? null,
          initialView: type.surface.initialView ?? null,
          components: type.surface.components.map((component) => ({ id: component.id, type: component.type, view: component.view ?? null })),
        },
        behavior: type.behavior,
      },
      '内容过长时请分事件精简后重读；setView 只能指向本题 surface.views 里声明的视图',
    )
  }
  if (layer === 'manifest') {
    return wrap(
      '题单层',
      { manifest: doc.content.manifest ?? null, auto: doc.content.manifest === undefined, run: doc.content.run },
      '可用 edit_manifest 设置显式题单或 run 配置',
    )
  }
  if (layer === 'flow') {
    return wrap('主流程层', doc.content.flow, '节点很多时建议逐段替换前先精简；务必保留 start 与连线端口')
  }
  return wrap('舞台 shell 层', doc.content.shell, '组件过多时可按视图分批读取（shell 无分页，可先 read_layer level 看视图）')
}

const readLayerTool: AiToolV4 = {
  name: 'read_layer',
  description:
    '读取 v4 文档某一层的完整内容（写入前必读，避免凭记忆重建）：' +
    'level=身份/meta/各层计数；types=题型定义（可给 typeId 只看一个）；tables=实例表（可给 typeId 只看一张）；' +
    'manifest=题单+run 配置；flow=主流程节点/连线/变量；behavior=题型行为图（typeId 必填，也可写成 layer="behavior:<typeId>"）；' +
    'shell=视图+shell 组件',
  parameters: {
    type: 'object',
    properties: {
      layer: {
        type: 'string',
        enum: [...V4_READ_LAYERS, 'behavior:<typeId>'],
        description: '要读取的层（behavior 也可写 behavior:<typeId>）',
      },
      typeId: { type: 'string', description: 'layer=behavior 必填；layer=types/tables 可选（只看该题型）' },
    },
    required: ['layer'],
  },
  exec: (args, ctx) => {
    const rawLayer = str(args.layer)
    // 兼容 docs/51 §5.3 的 `behavior:<typeId>` 写法：冒号后的题型 id 视为 typeId
    const colon = rawLayer.indexOf(':')
    const layer = colon >= 0 ? rawLayer.slice(0, colon) : rawLayer
    const typeId = str(args.typeId) || (colon >= 0 ? rawLayer.slice(colon + 1) : '')
    if (!(V4_READ_LAYERS as readonly string[]).includes(layer)) {
      return `读取失败：未知层 "${rawLayer}"。可用层：${V4_READ_LAYERS.join('、')}（behavior 可写 behavior:<typeId>）`
    }
    try {
      return renderLayerText(ctx.getDoc(), layer, typeId)
    } catch (err) {
      // 未知题型等定位失败：读工具不抛错，回可读文本让模型先修 read 参数
      return `读取失败：${err instanceof Error ? err.message : String(err)}`
    }
  },
}

const readRunLogTool: AiToolV4 = {
  name: 'read_run_log',
  description: '读取最近一次「▶ 试运行」的运行日志（v4 记录运行错误，带节点 id）。没有日志说明还没试运行过',
  parameters: { type: 'object', properties: {} },
  exec: (_args, ctx) => {
    const log = readRunLog(ctx.levelId)
    if (log.length === 0) {
      return '暂无试运行日志——用户还没有在编辑器点「▶ 试运行」运行过此关卡（AI 也可用 run_level 无头自验证）。'
    }
    const tail = log.slice(-MAX_LOG_ENTRIES)
    const lines = tail.map((e) =>
      e.kind === 'error'
        ? `- [错误]${e.nodeId ? `(节点 ${e.nodeId})` : ''}${e.event ? `[${e.event}]` : ''} ${e.message ?? ''}`
        : `- [命令] ${e.path ?? ''}`,
    )
    if (log.length > MAX_LOG_ENTRIES) lines.unshift(`（仅显示最近 ${MAX_LOG_ENTRIES} 条，共 ${log.length} 条）`)
    return lines.join('\n')
  },
}

const lintTool: AiToolV4 = {
  name: 'lint',
  description:
    '对当前 v4 文档做静态校验：loadLevelDocV4（JSON Schema + 结构/引用校验 + 语义 lint），返回全部错误/警告——' +
    '写入被拒绝后先用它定位问题',
  parameters: { type: 'object', properties: {} },
  exec: (_args, ctx) => {
    const doc = ctx.getDoc()
    const result = loadLevelDocV4(cloneLevelDocV4(doc))
    if (!result.ok) {
      return `【校验失败 ${result.errors.length} 条】请修正后再写入：\n${result.errors.map((e) => `- ${e}`).join('\n')}`
    }
    if (result.lintWarnings.length === 0) return '【校验通过】结构/引用/语义 lint 均无问题。'
    return [
      `【校验通过，含 ${result.lintWarnings.length} 条 lint 警告】（警告不阻断保存/运行，但可能让运行时静默失效）`,
      ...result.lintWarnings.slice(0, 40).map((w) => `- ${w}`),
      result.lintWarnings.length > 40 ? `…（其余 ${result.lintWarnings.length - 40} 条略）` : '',
    ]
      .filter((line) => line !== '')
      .join('\n')
  },
}

/** 解析 run_level 的 script / events 参数（统一成 harness 剧本） */
function parseHarnessScript(args: Record<string, unknown>, doc: LevelDocV4): { steps: HarnessStep[]; error?: string } {
  const shellIds = new Set(doc.content.shell.components.map((c) => c.id))
  const steps: HarnessStep[] = []
  const whenOf = (value: unknown): HarnessStep['when'] => {
    const when = str(value)
    return when === 'surface' || when === 'shellWait' || when === 'result' || when === 'finished' ? when : 'immediate'
  }

  for (const raw of arr(args.script)) {
    const step = obj(raw)
    const action = obj(step.action)
    const kind = str(action.kind)
    if (kind === 'surface' || kind === 'shell') {
      const component = str(action.component)
      const event = str(action.event)
      if (!component || !event) return { steps: [], error: 'script 的 surface/shell 步骤必须带 component 与 event' }
      steps.push({
        when: whenOf(step.when),
        action: { kind, component, event, payload: (action.payload ?? {}) as Json },
      })
    } else if (kind === 'wait') {
      const ms = num(action.ms)
      if (ms === undefined || ms < 0) return { steps: [], error: 'script 的 wait 步骤必须带非负 ms' }
      steps.push({ when: whenOf(step.when), action: { kind: 'wait', ms } })
    } else {
      return { steps: [], error: 'script 每步格式：{ when?, action: { kind: "surface"|"shell"|"wait", … } }' }
    }
  }

  for (const raw of arr(args.events)) {
    const event = obj(raw)
    const name = str(event.event)
    if (!name) return { steps: [], error: 'events 每步必须带 event（形如 "组件id.事件名"）' }
    const dot = name.indexOf('.')
    if (dot <= 0 || dot === name.length - 1) {
      return { steps: [], error: `事件名 "${name}" 非法：应为 "组件id.事件名"` }
    }
    const component = name.slice(0, dot)
    const eventName = name.slice(dot + 1)
    const waitMs = num(event.waitMs)
    const isShell = shellIds.has(component)
    const when = str(event.when)
    steps.push({
      when: when === 'immediate' || when === 'surface' || when === 'shellWait' ? when : isShell ? 'shellWait' : 'surface',
      action: {
        kind: isShell ? 'shell' : 'surface',
        component,
        event: eventName,
        payload: (event.payload ?? {}) as Json,
      },
    })
    if (waitMs !== undefined && waitMs > 0) steps.push({ when: 'immediate', action: { kind: 'wait', ms: waitMs } })
  }
  return { steps }
}

const runLevelTool: AiToolV4 = {
  name: 'run_level',
  description:
    '无头试运行当前 v4 关卡（不打开游玩页）：自动跑完整流程，可注入事件剧本模拟作答，返回每题结果 / score / passed / ' +
    '流程是否结束 / 运行日志错误。**每次修改流程、题型行为或数据后都应跑一次自验证**。' +
    'events 简写：[{ event: "组件id.事件名", payload?, waitMs? }]（shell 组件事件自动等 waitShell，surface 事件等题目出现）；' +
    'script 完整格式：[{ when?, action: { kind: "surface"|"shell"|"wait", component?, event?, payload?, ms? } }]',
  parameters: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        description: '事件剧本简写：每步 { event, payload?, waitMs? }',
        items: { type: 'object' },
      },
      script: {
        type: 'array',
        description: '完整 harness 剧本：每步 { when?, action }（优先于 events）',
        items: { type: 'object' },
      },
      seed: { type: ['number', 'string', 'null'], description: '固定牌堆 seed（可选；用于复现）' },
      timeoutMs: { type: 'number', description: '总超时毫秒（默认 3000；超时说明流程卡住）' },
    },
  },
  exec: async (args, ctx) => {
    if (ctx.signal?.aborted) return '运行已停止。'
    const doc = ctx.getDoc()
    // 先做装载预检：结构/引用坏掉的文档跑无头只会得到难懂的内部错误——先回可读错误让模型修
    const precheck = loadLevelDocV4(cloneLevelDocV4(doc))
    if (!precheck.ok) {
      return `运行失败（未执行）：文档未通过校验，请先修复（lint 可看到完整清单）：\n${precheck.errors
        .map((error) => `- ${error}`)
        .join('\n')}`
    }
    const parsed = parseHarnessScript(args, doc)
    if (parsed.error) return `运行失败（未执行）：${parsed.error}`
    const timeoutMs = Math.min(15_000, Math.max(100, num(args.timeoutMs) ?? 3000))
    const seedArg = args.seed
    const seed = seedArg === undefined ? undefined : (seedArg as number | string | null)
    const report = await runLevelHeadless(doc, { seed, script: parsed.steps, timeoutMs })
    if (ctx.signal?.aborted) return '运行已停止（结果未采信）。'

    const lines: string[] = []
    if (report.ok) lines.push('✓ 流程已结束')
    else if (report.finished) lines.push(`⚠ 流程结束但有运行错误`)
    else lines.push(`✗ 流程未在 ${timeoutMs}ms 内结束${parsed.steps.length === 0 ? '（可能需要事件剧本才能作答，或流程卡住）' : ''}`)
    if (report.error) lines.push(`运行错误：${report.error}`)
    lines.push(
      report.result
        ? `【结算】score=${report.result.score} passed=${report.result.passed}`
        : '【结算】未产生结算结果（流程没有走到 finish）',
    )
    lines.push(
      `【牌堆】${report.deck.length} 题（seed=${report.seed}）：${
        report.deck.map((d) => `${d.type}/${d.row}`).join('、') || '（空）'
      }`,
    )
    if (report.questions.length === 0) {
      lines.push('【每题返回】（无题目被调用）')
    } else {
      lines.push(
        '【每题返回】\n' +
          report.questions
            .map((q, i) => {
              const r = q.result
              const bits = [`status=${r.status ?? 'answered'}`]
              if (r.correct !== undefined) bits.push(`correct=${r.correct}`)
              if (r.scoreDelta !== undefined) bits.push(`scoreDelta=${r.scoreDelta}`)
              if (r.message) bits.push(`message=${oneLine(r.message)}`)
              return `${i + 1}. ${q.typeId}/${q.rowId} → ${bits.join(' ')}`
            })
            .join('\n'),
      )
    }
    const problems = report.logs.filter((e) => e.kind === 'error' || e.kind === 'warning' || e.kind === 'unsettled')
    if (problems.length > 0) {
      lines.push(
        `【运行日志问题 ${problems.length} 条】\n` +
          problems
            .slice(-MAX_RUN_LOGS)
            .map((e) => `- [${e.kind}]${e.nodeId ? `(节点 ${e.nodeId})` : ''} ${e.message ?? ''}`)
            .join('\n'),
      )
    } else {
      lines.push('【运行日志】无错误/警告。')
    }
    return lines.join('\n')
  },
}

// ---------------------------------------------------------------------------
// 写工具：meta
// ---------------------------------------------------------------------------

const editMetaTool: AiToolV4 = {
  name: 'edit_meta',
  description:
    '修改关卡 meta（title/description/tags/difficulty 等 JSON 字段，浅合并）。' +
    '其余层（题型/实例表/题单/流程/舞台）各有独立工具——一次只改一层',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'object',
        description: '要写入 meta 的字段（如 { "title": "新标题", "description": "说明" }）；title 不能为空',
      },
    },
    required: ['patch'],
  },
  exec: (args, ctx) => {
    const patch = obj(args.patch)
    const keys = Object.keys(patch)
    if (keys.length === 0) return '修改失败（未应用）：patch 不能为空'
    return applyAndCheckV4(
      ctx,
      (applied) => `meta 已更新（${keys.join('、')}）——标题：${str(applied.meta.title)}`,
      (doc) => withMeta(doc, patch as Partial<LevelDocV4['meta']>),
    )
  },
}

// ---------------------------------------------------------------------------
// 写工具：types（题型定义）
// ---------------------------------------------------------------------------

const editTypesTool: AiToolV4 = {
  name: 'edit_types',
  description:
    '增删改排序题型定义（不含实例表内容——表用 edit_table）与题型行为图（也可用 edit_behavior）。' +
    'op=add：type 给 {id?, name, description?, surface?, behavior?, state?, typeState?, args?, table?}；' +
    'op=update：给 typeId + type 的部分字段（state/typeState/args 为整组替换）；op=remove：级联删实例表与显式题单条目；' +
    'op=move：typeId 移到 toIndex（影响自动题单平票顺序）',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'update', 'remove', 'move'], description: '操作类型' },
      typeId: { type: 'string', description: 'op=update/remove/move 的题型 id' },
      type: { type: 'object', description: 'op=add/update 的题型定义或部分字段' },
      toIndex: { type: 'number', description: 'op=move 的目标下标（0 起）' },
    },
    required: ['op'],
  },
  exec: (args, ctx) => {
    const op = str(args.op)
    const typeId = str(args.typeId)
    if (op === 'add') {
      const seed = obj(args.type) as AddTypeSeed
      let createdId = ''
      return applyAndCheckV4(
        ctx,
        () => `题型 ${createdId}（${str(seed.name)}）已新增（含空实例表）`,
        (doc) => {
          const result = addType(doc, seed)
          createdId = result.id
          return result.doc
        },
      )
    }
    if (op === 'update' || op === 'remove' || op === 'move') {
      if (!typeId) return `修改失败（未应用）：op=${op} 需要 typeId`
      return applyAndCheckV4(
        ctx,
        (applied) => {
          if (op === 'remove') return `题型 ${typeId} 已删除（实例表与显式题单条目已级联清理）`
          if (op === 'move') return `题型 ${typeId} 已移到第 ${num(args.toIndex) ?? 0} 位（当前顺序：${typeListText(applied)}）`
          const type = getType(applied, typeId)
          return `题型 ${typeId} 已更新（${Object.keys(obj(args.type)).join('、') || '无字段'}）${type ? `——名称：${type.name}` : ''}`
        },
        (doc) => {
          requireType(doc, typeId)
          if (op === 'remove') return removeType(doc, typeId)
          if (op === 'update') return updateType(doc, typeId, obj(args.type) as Partial<QuestionTypeDef>)
          const target = Math.max(0, Math.min(doc.content.types.length - 1, Math.trunc(num(args.toIndex) ?? 0)))
          const from = doc.content.types.findIndex((t) => t.id === typeId)
          if (from === target) return doc
          const types = doc.content.types.slice()
          const [moved] = types.splice(from, 1)
          types.splice(target, 0, moved)
          return { ...doc, content: { ...doc.content, types } }
        },
      )
    }
    return `修改失败（未应用）：未知 op "${op}"（可用：add/update/remove/move）`
  },
}

// ---------------------------------------------------------------------------
// 写工具：table（实例表）
// ---------------------------------------------------------------------------

const editTableTool: AiToolV4 = {
  name: 'edit_table',
  description:
    '编辑某题型的实例表（一行 = 一道题；行 id 稳定、由工具生成）。必须先 read_layer layer=tables typeId=… 再改。' +
    'op=add_rows：rows 数组成员为单元格对象（列名→值，可带 draft/phase/order），自动生成行 id 并在结果中返回；' +
    'op=update_rows：rows 每项必须有 id（+ 要改的单元格/元数据），只改给出的字段；' +
    'op=remove_rows：ids 数组；op=add_column/update_column/remove_column：column 对象（update_column 可用 newKey 重命名）；' +
    'op=move_row：rowId + toIndex；op=replace：table 全文替换（保留行 id，不用于新增行）',
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: [
          'add_rows',
          'update_rows',
          'remove_rows',
          'add_column',
          'update_column',
          'remove_column',
          'move_row',
          'replace',
        ],
        description: '操作类型',
      },
      typeId: { type: 'string', description: '题型 id（实例表 key）' },
      rows: { type: 'array', items: { type: 'object' }, description: 'op=add_rows/update_rows 的行数据' },
      ids: { type: 'array', items: { type: 'string' }, description: 'op=remove_rows 的行 id 列表' },
      column: { type: 'object', description: 'op=add_column/update_column/remove_column 的列定义（key 必填）' },
      rowId: { type: 'string', description: 'op=move_row 的行 id' },
      toIndex: { type: 'number', description: 'op=move_row 的目标下标（0 起）' },
      table: { type: 'object', description: 'op=replace 的完整实例表 { columns, rows }' },
      afterRowId: { type: 'string', description: 'op=add_rows 可选：插到该行之后（缺省追加到末尾）' },
    },
    required: ['op', 'typeId'],
  },
  exec: (args, ctx) => {
    const op = str(args.op)
    const typeId = str(args.typeId)
    if (!typeId) return '修改失败（未应用）：缺少 typeId'
    /** 摘要用运行内数据（行 id 等生成结果） */
    const addedIds: string[] = []
    const changed: string[] = []

    return applyAndCheckV4(
      ctx,
      () => {
        if (op === 'add_rows') {
          const ids = addedIds.length > 0 ? `（行 id：${addedIds.join('、')}）` : ''
          return `实例表 ${typeId} 已追加 ${addedIds.length} 行${ids}——做题/题单引用可直接使用这些 id`
        }
        if (changed.length > 0) return `实例表 ${typeId} 已更新（${changed.join('；')}）`
        return `实例表 ${typeId} 已更新（op=${op}）`
      },
      (doc) => {
        requireType(doc, typeId) // 未知题型先给可读错误（不等到 addRow 的「没有实例表」）
        let next = doc
        if (op === 'add_rows') {
          const rows = arr(args.rows)
          if (rows.length === 0) throw new Error('add_rows 的 rows 不能为空')
          let anchor = str(args.afterRowId) || undefined
          for (const raw of rows) {
            const spec = obj(raw)
            const { cells, meta } = splitRowSpec(spec)
            const result = addRow(next, typeId, anchor)
            next = result.doc
            anchor = result.rowId
            addedIds.push(result.rowId)
            let table = requireTable(next, typeId)
            for (const [key, value] of Object.entries(cells)) {
              assertColumnExists(table, key)
              next = updateTableCell(next, typeId, result.rowId, key, (value ?? null) as Json)
              table = requireTable(next, typeId)
            }
            if (Object.keys(meta).length > 0) next = updateRowMeta(next, typeId, result.rowId, meta)
          }
          return next
        }
        if (op === 'update_rows') {
          const rows = arr(args.rows)
          if (rows.length === 0) throw new Error('update_rows 的 rows 不能为空')
          for (const raw of rows) {
            const spec = obj(raw)
            const rowId = str(spec.id)
            if (!rowId) throw new Error('update_rows 的每行必须带 id（先用 read_layer layer=tables 读取真实行 id）')
            const table = requireTable(next, typeId)
            if (!table.rows.some((r) => r.id === rowId)) {
              throw new Error(
                `行 "${rowId}" 不存在（题型 ${typeId} 现有行：${table.rows.map((r) => r.id).join('、') || '无'}）`,
              )
            }
            const { cells, meta } = splitRowSpec(spec)
            let currentTable = table
            for (const [key, value] of Object.entries(cells)) {
              assertColumnExists(currentTable, key)
              next = updateTableCell(next, typeId, rowId, key, (value ?? null) as Json)
              currentTable = requireTable(next, typeId)
            }
            if (Object.keys(meta).length > 0) next = updateRowMeta(next, typeId, rowId, meta)
            changed.push(`行 ${rowId}（${Object.keys(cells).join('、') || '元数据'}）`)
          }
          return next
        }
        if (op === 'remove_rows') {
          const ids = arr(args.ids).map((v) => str(v)).filter((v) => v !== '')
          if (ids.length === 0) throw new Error('remove_rows 的 ids 不能为空')
          const table = requireTable(next, typeId)
          const missing = ids.filter((id) => !table.rows.some((r) => r.id === id))
          if (missing.length > 0) {
            throw new Error(
              `行 ${missing.join('、')} 不存在（现有：${table.rows.map((r) => r.id).join('、') || '无'}）——先 read_layer 再删`,
            )
          }
          for (const id of ids) next = removeRow(next, typeId, id)
          changed.push(`删除 ${ids.length} 行（${ids.join('、')}）`)
          return next
        }
        if (op === 'add_column') {
          const column = obj(args.column)
          const key = str(column.key)
          if (!key) throw new Error('add_column 的 column.key 不能为空')
          next = addColumn(next, typeId, {
            key,
            ...(column.label !== undefined ? { label: str(column.label) } : {}),
            ...(column.type !== undefined ? { type: str(column.type) as ColumnType } : {}),
          })
          changed.push(`新增列 ${key}（${str(column.type) || 'text'}）`)
          return next
        }
        if (op === 'update_column' || op === 'remove_column') {
          const column = obj(args.column)
          const key = str(column.key)
          if (!key) throw new Error(`${op} 的 column.key 不能为空`)
          const table = requireTable(next, typeId)
          if (!table.columns.some((c) => c.key === key)) {
            throw new Error(`列 "${key}" 不存在（现有列：${table.columns.map((c) => c.key).join('、') || '无'}）`)
          }
          if (op === 'remove_column') {
            next = removeColumn(next, typeId, key)
            changed.push(`删除列 ${key}`)
            return next
          }
          const newKey = str(column.newKey)
          let targetKey = key
          if (newKey && newKey !== key) {
            next = renameColumn(next, typeId, key, newKey)
            targetKey = newKey
          }
          next = updateColumn(next, typeId, targetKey, {
            ...(column.label !== undefined ? { label: str(column.label) } : {}),
            ...(column.type !== undefined ? { type: str(column.type) as ColumnType } : {}),
          })
          changed.push(newKey && newKey !== key ? `列 ${key} 已改名为 ${newKey}` : `列 ${key}`)
          return next
        }
        if (op === 'move_row') {
          const rowId = str(args.rowId)
          const toIndex = num(args.toIndex)
          if (!rowId) throw new Error('move_row 需要 rowId')
          if (toIndex === undefined) throw new Error('move_row 需要 toIndex')
          const table = requireTable(next, typeId)
          if (!table.rows.some((r) => r.id === rowId)) throw new Error(`行 "${rowId}" 不存在`)
          next = moveRow(next, typeId, rowId, toIndex)
          changed.push(`行 ${rowId} 移到第 ${Math.trunc(toIndex)} 位`)
          return next
        }
        if (op === 'replace') {
          const table = obj(args.table)
          const columns = arr(table.columns)
          const rows = arr(table.rows)
          const seen = new Set<string>()
          for (const raw of rows) {
            const row = obj(raw)
            const id = str(row.id)
            if (!id) throw new Error('replace 的每一行都必须带稳定 id（新增行请用 add_rows 自动生成 id）')
            if (seen.has(id)) throw new Error(`replace 的行 id "${id}" 重复`)
            seen.add(id)
          }
          // 删除旧行的显式题单条目由 loadLevelDocV4 的引用校验兜底（悬空 row 会报错）
          const nextTable = {
            columns: columns as QuestionTable['columns'],
            rows: rows as unknown as QuestionRow[],
          }
          changed.push(`整表替换（${nextTable.rows.length} 行 / ${nextTable.columns.length} 列）`)
          return { ...next, content: { ...next.content, tables: { ...next.content.tables, [typeId]: nextTable } } }
        }
        throw new Error(`未知 op "${op}"（可用：add_rows/update_rows/remove_rows/add_column/update_column/remove_column/move_row/replace）`)
      },
    )
  },
}

// ---------------------------------------------------------------------------
// 写工具：manifest + run
// ---------------------------------------------------------------------------

const editManifestTool: AiToolV4 = {
  name: 'edit_manifest',
  description:
    '设置题单与 run 配置（自动题单 = 不设显式 manifest）。op=auto：删除显式 manifest 回到自动题单；' +
    'op=set：entries 全文替换 [{type,row,args?}；op=append：追加到现有显式题单；op=remove：从显式题单删除匹配 {type,row} 的条目；' +
    'op=run：只改 run 配置（order=manifest|shuffle、count、seed、shuffleWithinPhase）。建议先 read_layer layer=manifest',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['auto', 'set', 'append', 'remove', 'run'], description: '操作类型' },
      entries: { type: 'array', items: { type: 'object' }, description: 'op=set/append/remove 的题单条目' },
      run: { type: 'object', description: 'op=run 的 run 配置（只需给要改的键）' },
    },
    required: ['op'],
  },
  exec: (args, ctx) => {
    const op = str(args.op)
    return applyAndCheckV4(
      ctx,
      (applied) => {
        if (op === 'auto') return '题单已恢复为自动题单（按各表 phase/order 生成）'
        if (op === 'run') return `run 配置已更新（order=${applied.content.run.order} count=${applied.content.run.count ?? 'null'} seed=${applied.content.run.seed ?? 'null'} shuffleWithinPhase=${applied.content.run.shuffleWithinPhase}）`
        const count = applied.content.manifest?.entries.length ?? 0
        return `显式题单已${op === 'set' ? '设为' : op === 'append' ? '追加后为' : '删除后为'} ${count} 项`
      },
      (doc) => {
        if (op === 'auto') return setManifest(doc, null)
        if (op === 'run') {
          const patch = obj(args.run)
          if (has(patch, 'order') && patch.order !== 'manifest' && patch.order !== 'shuffle') {
            throw new Error('run.order 只能是 "manifest" 或 "shuffle"')
          }
          if (has(patch, 'count') && patch.count !== null && typeof patch.count !== 'number') {
            throw new Error('run.count 必须是数字或 null')
          }
          if (has(patch, 'shuffleWithinPhase') && typeof patch.shuffleWithinPhase !== 'boolean') {
            throw new Error('run.shuffleWithinPhase 必须是布尔')
          }
          return setRunConfig(doc, patch as Partial<RunConfig>)
        }
        if (op === 'set' || op === 'append') {
          const entries = arr(args.entries).map(manifestEntry)
          if (entries.length === 0) throw new Error(`${op} 的 entries 不能为空（清空请用 op=auto）`)
          const base = op === 'append' ? (doc.content.manifest?.entries ?? []) : []
          return setManifest(doc, { entries: [...base, ...entries] })
        }
        if (op === 'remove') {
          const removeList = arr(args.entries).map(manifestEntry)
          if (removeList.length === 0) throw new Error('remove 的 entries 不能为空')
          const current = doc.content.manifest
          if (!current) throw new Error('当前是自动题单，没有可删除的显式题单条目')
          const keep = current.entries.filter(
            (e) => !removeList.some((r) => r.type === e.type && r.row === e.row),
          )
          return setManifest(doc, { entries: keep })
        }
        throw new Error(`未知 op "${op}"（可用：auto/set/append/remove/run）`)
      },
    )
  },
}

// ---------------------------------------------------------------------------
// 写工具：flow（主流程层）
// ---------------------------------------------------------------------------

const editFlowTool: AiToolV4 = {
  name: 'edit_flow',
  description:
    '整体替换关卡主流程 flow（Flow main）。必须先 read_layer layer=flow 读现有节点/连线/变量，再按需改写后整体提交。' +
    'nodes 节点 kind：start/assign/ask/foreach/branch/loop/call/setView/wait/waitShell/finish/restart/comment；' +
    'edges 连线 { id, from, to, port? }（branch/loop/foreach 出边必须端口 true/false，每端口最多一条）；' +
    'vars 可选（给数组=替换 run 变量声明；省略=保留现有；null=清空）。改完必须 run_level 自验证',
  parameters: {
    type: 'object',
    properties: {
      nodes: { type: 'array', items: { type: 'object' }, description: '完整节点数组（整体替换）' },
      edges: { type: 'array', items: { type: 'object' }, description: '完整连线数组（整体替换）' },
      vars: {
        type: ['array', 'null'],
        description: 'run 变量声明 [{key,type,init}]；省略=保留现有，null=清空',
        items: { type: 'object' },
      },
    },
    required: ['nodes', 'edges'],
  },
  exec: (args, ctx) => {
    const nodes = arr(args.nodes)
    const edges = arr(args.edges)
    return applyAndCheckV4(
      ctx,
      (applied) =>
        `主流程已替换（${applied.content.flow.nodes.length} 节点 / ${applied.content.flow.edges.length} 连线 / ` +
        `${applied.content.flow.vars?.length ?? 0} 个 run 变量）——请再 run_level 验证`,
      (doc) => {
        const current = doc.content.flow
        const program: FlowProgram = {
          logicVersion: LOGIC_VERSION_V4,
          kind: 'flow',
          nodes: nodes as unknown as FlowProgram['nodes'],
          edges: edges as unknown as FlowProgram['edges'],
        }
        if (args.vars === undefined) {
          if (current.vars !== undefined) program.vars = current.vars
        } else if (args.vars !== null) {
          program.vars = arr(args.vars) as unknown as FlowProgram['vars']
        }
        return updateFlow(doc, () => program)
      },
    )
  },
}

// ---------------------------------------------------------------------------
// 写工具：behavior（题型行为层）
// ---------------------------------------------------------------------------

const editBehaviorTool: AiToolV4 = {
  name: 'edit_behavior',
  description:
    '整体替换某题型的 behavior 行为图（一次 ask 调用的异步函数）。必须先 read_layer layer=behavior typeId=… 再改写。' +
    'nodes kind：on（event="start" / "组件id.事件名" / "internal.名称"）/ assign / call / emit / branch / loop / wait / comment / return；' +
    'edges { id, from, to, port? }；locals 可选（每次调用 local.* 初值 [{key,type,init}]）。改完必须 run_level 自验证',
  parameters: {
    type: 'object',
    properties: {
      typeId: { type: 'string', description: '题型 id' },
      nodes: { type: 'array', items: { type: 'object' }, description: '完整行为节点数组（整体替换）' },
      edges: { type: 'array', items: { type: 'object' }, description: '完整连线数组（整体替换）' },
      locals: {
        type: ['array', 'null'],
        description: 'local 变量初值 [{key,type,init}]；省略=保留现有，null=清空',
        items: { type: 'object' },
      },
    },
    required: ['typeId', 'nodes', 'edges'],
  },
  exec: (args, ctx) => {
    const typeId = str(args.typeId)
    if (!typeId) return '修改失败（未应用）：缺少 typeId'
    const nodes = arr(args.nodes)
    const edges = arr(args.edges)
    return applyAndCheckV4(
      ctx,
      (applied) => {
        const type = getType(applied, typeId)
        const events = (type?.behavior.nodes ?? [])
          .filter((n) => n.kind === 'on')
          .map((n) => (n as { event: string }).event)
        return `题型 ${typeId} 的行为图已替换（${nodes.length} 节点 / ${edges.length} 连线；事件入口：${events.join('、') || '无'}）`
      },
      (doc) => {
        requireType(doc, typeId)
        return updateBehavior(doc, typeId, (current) => {
          const program: BehaviorProgram = {
            logicVersion: LOGIC_VERSION_V4,
            kind: 'behavior',
            nodes: nodes as unknown as BehaviorProgram['nodes'],
            edges: edges as unknown as BehaviorProgram['edges'],
          }
          if (args.locals === undefined) {
            if (current.locals !== undefined) program.locals = current.locals
          } else if (args.locals !== null) {
            program.locals = arr(args.locals) as unknown as BehaviorProgram['locals']
          }
          return program
        })
      },
    )
  },
}

// ---------------------------------------------------------------------------
// 写工具：shell（舞台层）
// ---------------------------------------------------------------------------

const editShellTool: AiToolV4 = {
  name: 'edit_shell',
  description:
    '编辑舞台 shell 层（视图与常驻组件）。必须先 read_layer layer=shell。' +
    'op=add_component：component={type 必填, id?, name?, view?, layout?{x,y,w,h}, props?, bindings?, visible?}；' +
    'op=update_component：componentId + component 部分字段（layout/props/bindings 等）；op=remove_component：componentId；' +
    'op=add_view：view={name?}；op=update_view：viewId + view.name；op=remove_view：viewId（级联删该视图组件）；' +
    'op=set_initial_view：viewId（空串=清除 initialView）；op=replace：shell={views,components,initialView?} 整体替换。' +
    '组件可用类型与 props 契约见 read_doc',
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: [
          'add_component',
          'update_component',
          'remove_component',
          'add_view',
          'update_view',
          'remove_view',
          'set_initial_view',
          'replace',
        ],
        description: '操作类型',
      },
      component: { type: 'object', description: '组件定义/部分字段（type/id/view/layout/props/bindings…）' },
      componentId: { type: 'string', description: '组件 id' },
      view: { type: 'object', description: '视图定义（op=add_view/update_view 用 { name? }）' },
      viewId: { type: 'string', description: '视图 id（op=update_view/remove_view/set_initial_view）' },
      shell: { type: 'object', description: 'op=replace 的完整 shell { views, components, initialView? }' },
    },
    required: ['op'],
  },
  exec: (args, ctx) => {
    const op = str(args.op)
    let addedComponentId = ''
    let addedViewId = ''
    const componentId = str(args.componentId)
    if ((op === 'update_component' || op === 'remove_component') && !componentId) {
      return `修改失败（未应用）：op=${op} 需要 componentId`
    }
    return applyAndCheckV4(
      ctx,
      (applied) => {
        const shell = applied.content.shell
        if (op === 'add_component') return `shell 已新增组件 ${addedComponentId}（当前 ${shell.components.length} 个组件，视图 ${shell.views.length} 个）`
        if (op === 'add_view') return `shell 已新增视图 ${addedViewId}（视图：${shell.views.map((v) => v.id).join('、')}）`
        if (op === 'remove_view') return `视图 ${str(args.viewId)} 已删除（剩余：${shell.views.map((v) => v.id).join('、')}）`
        if (op === 'replace') return `shell 已整体替换（视图 ${shell.views.length} 个 / 组件 ${shell.components.length} 个）`
        return `shell 已更新（op=${op}${componentId ? `，组件 ${componentId}` : ''}${str(args.viewId) ? `，视图 ${str(args.viewId)}` : ''}）`
      },
      (doc) => {
        const shell = doc.content.shell
        if (op === 'add_component') {
          const spec = obj(args.component)
          const type = str(spec.type)
          if (!type) throw new Error('add_component 的 component.type 不能为空（可用类型见 read_doc 的组件目录）')
          const init = { ...spec } as Partial<ComponentInstanceV4>
          delete (init as { type?: string }).type
          const result = addComponent(doc, SHELL_LAYER, type, init)
          addedComponentId = result.id
          return result.doc
        }
        if (op === 'update_component') {
          if (!shell.components.some((c) => c.id === componentId)) {
            throw new Error(`shell 组件 "${componentId}" 不存在（现有：${shell.components.map((c) => c.id).join('、') || '无'}）`)
          }
          return updateComponent(doc, SHELL_LAYER, componentId, obj(args.component) as Partial<ComponentInstanceV4>)
        }
        if (op === 'remove_component') {
          if (!shell.components.some((c) => c.id === componentId)) {
            throw new Error(`shell 组件 "${componentId}" 不存在（现有：${shell.components.map((c) => c.id).join('、') || '无'}）`)
          }
          return removeComponent(doc, SHELL_LAYER, componentId)
        }
        if (op === 'add_view') {
          const result = addView(doc, str(obj(args.view).name) || undefined)
          addedViewId = result.id
          return result.doc
        }
        if (op === 'update_view') {
          const viewId = str(args.viewId)
          if (!shell.views.some((v) => v.id === viewId)) {
            throw new Error(`视图 "${viewId}" 不存在（现有：${shell.views.map((v) => v.id).join('、')}）`)
          }
          return updateView(doc, viewId, { name: str(obj(args.view).name) })
        }
        if (op === 'remove_view') {
          const viewId = str(args.viewId)
          if (!shell.views.some((v) => v.id === viewId)) {
            throw new Error(`视图 "${viewId}" 不存在（现有：${shell.views.map((v) => v.id).join('、')}）`)
          }
          if (shell.views.length <= 1) throw new Error('至少保留一个视图（schema 约束）')
          return removeView(doc, viewId)
        }
        if (op === 'set_initial_view') {
          const viewId = str(args.viewId)
          if (viewId !== '' && !shell.views.some((v) => v.id === viewId)) {
            throw new Error(`视图 "${viewId}" 不存在（现有：${shell.views.map((v) => v.id).join('、')}）`)
          }
          return updateShell(doc, (current) => {
            const next = { ...current }
            if (viewId === '') delete next.initialView
            else next.initialView = viewId
            return next
          })
        }
        if (op === 'replace') {
          const spec = obj(args.shell)
          const views = arr(spec.views)
          if (views.length === 0) throw new Error('replace 的 shell.views 至少需要一个视图')
          if (!views.some((v) => obj(v).id === (str(spec.initialView) || obj(views[0]).id))) {
            throw new Error('replace 的 shell.initialView 必须指向 views 内已存在的视图')
          }
          return updateShell(doc, () => spec as unknown as LevelDocV4['content']['shell'])
        }
        throw new Error(
          `未知 op "${op}"（可用：add_component/update_component/remove_component/add_view/update_view/remove_view/set_initial_view/replace）`,
        )
      },
    )
  },
}

// ---------------------------------------------------------------------------
// 工具集导出
// ---------------------------------------------------------------------------

/** 只读工具集（ask 模式可用；agent 模式也全部可用） */
export const V4_READ_TOOLS: AiToolV4[] = [
  readDocTool,
  readLayerTool,
  readRunLogTool,
  lintTool,
  runLevelTool,
]

/** 写工具七件套（仅 agent 模式） */
export const V4_WRITE_TOOLS: AiToolV4[] = [
  editMetaTool,
  editTypesTool,
  editTableTool,
  editManifestTool,
  editFlowTool,
  editBehaviorTool,
  editShellTool,
]

/** 按模式取工具集：ask 只读；agent = 只读 + 按层写 */
export function getV4Tools(mode: 'ask' | 'plan' | 'agent'): AiToolV4[] {
  return mode === 'agent' ? [...V4_READ_TOOLS, ...V4_WRITE_TOOLS] : [...V4_READ_TOOLS]
}

/** 供 AiPanelV4 做「本层可写工具」提示 */
export const V4_WRITE_TOOL_NAMES = V4_WRITE_TOOLS.map((tool) => tool.name)
