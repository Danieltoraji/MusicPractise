/**
 * v4 预设画廊（docs/52 §4 W8.1；docs/53 §14）：
 * 列表（flow/behavior 分层）→ 说明 → 参数表单 → 「插入到当前层」。
 *
 * 设计要点：
 * - **纯表现层**：只读 `doc` 计算预览，不直接改文档；插入通过 `onInsert({nodes, edges, entryId?})`
 *   把展开好的**普通节点组**交给宿主（Lead 接入图工作台的插入 API）。
 * - 参数表单按 `PresetDef.params` 的 expr/text/number/select 渲染；表达式参数实时 `checkV4Expr`
 *   校验（根/语法），非法时禁用插入。
 * - 插入前预览：把产物临时并入文档跑 `lintLevelDocV4`，只展示「由本次展开节点引入」的问题，
 *   并列出 flow 预设需要、但当前文档缺失的 run 变量声明（画廊不改 doc，需作者在变量面板补；
 *   宿主也可读取插入结果里可选的 `declarations`，在一次 update 里顺带补齐声明）。
 * - 节点落点：读取同层程序已有坐标，把节点组平移放到现有内容右侧（3 列网格），不与已有节点重叠。
 * - 锚点：`v4-preset-*`（G3 契约）；样式在 `v4-presets.css`（仅增量、全 var() 令牌、无裸色）。
 */
import { useMemo, useState } from 'react'
import type { Json } from '../../../engine/expr'
import { BEHAVIOR_ROOTS, FLOW_ROOTS, checkV4Expr } from '../../../engine/v4/expr'
import { lintLevelDocV4 } from '../../../engine/v4/lint'
import { validateLevelDocV4 } from '../../../engine/v4/validate'
import type { BehaviorProgram, FlowProgram, GraphEdge, LevelDocV4, StateFieldDef } from '../../../engine/v4/model'
import { getType, type BehaviorNode, type FlowNode } from '../../../engine/v4/model'
import {
  applyPresetResultToDoc,
  buildPreset,
  normalizePresetParams,
  presetDeclarations,
  presetsByLayer,
} from '../../../engine/v4/presets'
import { allContracts } from '../../../runtime/store'
import '../v4-presets.css'

/** 节点尺寸/间距口径与 editor/v4/graph/layout.ts 的 NODE_W/NODE_H 保持一致（这里不 import dagre） */
const NODE_W = 244
const NODE_H = 84
const GRID_GAP_X = 44
const GRID_GAP_Y = 56
const GRID_COLUMNS = 3

const CONTRACTS = new Map(allContracts().map((contract) => [contract.type, contract]))

export interface PresetInsertResult {
  nodes: (FlowNode | BehaviorNode)[]
  edges: GraphEdge[]
  entryId?: string
  /**
   * 扩展（向后兼容，宿主可忽略）：本次插入的预设 id。
   * 宿主可据此在同一个 update 里额外处理（例如写注释/埋点/校验层）。
   */
  presetId?: string
  /**
   * 扩展（向后兼容，宿主可忽略）：flow 预设依赖、但当前文档缺失的 run 变量声明。
   * 宿主插入节点时若同时把它们并入 `flow.vars`，即可一次 update 消除「未声明 run 变量」lint 错误
   * （behavior 层恒无此字段）。
   */
  declarations?: StateFieldDef[]
}

export interface PresetGalleryProps {
  /** 当前编辑器文档（只读：画廊不改文档） */
  doc: LevelDocV4
  /** 插入层：flow = 关卡主流程；behavior = 题型行为（需同时给 typeId） */
  layer: 'flow' | 'behavior'
  /** behavior 层必填：题型 id（决定写入哪张行为图、surface 组件校验） */
  typeId?: string
  /** 插入回调：收到已展开 + 定位好的普通节点组（宿主负责并入文档） */
  onInsert: (result: PresetInsertResult) => void
}

type ParamOverrides = Record<string, Record<string, Json>>

function paramSignature(params: Record<string, Json>): string {
  return JSON.stringify(params)
}

function programOf(doc: LevelDocV4, layer: 'flow' | 'behavior', typeId?: string): FlowProgram | BehaviorProgram | undefined {
  if (layer === 'flow') return doc.content.flow
  if (typeId === undefined || typeId === '') return undefined
  return getType(doc, typeId)?.behavior
}

/** 把展开节点平移放到现有内容右侧的 3 列网格（相对坐标 → 绝对坐标） */
function placeNodes(
  nodes: (FlowNode | BehaviorNode)[],
  program: FlowProgram | BehaviorProgram | undefined,
): (FlowNode | BehaviorNode)[] {
  const positioned: { x: number; y: number }[] = []
  for (const node of program?.nodes ?? []) {
    const x = (node as { x?: unknown }).x
    const y = (node as { y?: unknown }).y
    if (typeof x === 'number' && typeof y === 'number') positioned.push({ x, y })
  }
  const originX = positioned.length > 0 ? Math.max(...positioned.map((point) => point.x + NODE_W)) + GRID_GAP_X : 40
  const originY = positioned.length > 0 ? Math.min(...positioned.map((point) => point.y)) : 40
  return nodes.map((node, index) => ({
    ...node,
    x: originX + (index % GRID_COLUMNS) * (NODE_W + GRID_GAP_X),
    y: originY + Math.floor(index / GRID_COLUMNS) * (NODE_H + GRID_GAP_Y),
  }))
}

function paramValueText(value: Json | undefined): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

export function PresetGallery(props: PresetGalleryProps): React.ReactElement {
  const { doc, layer, typeId, onInsert } = props
  const presets = useMemo(() => presetsByLayer(layer), [layer])
  const [selectedId, setSelectedId] = useState<string>(() => presets[0]?.id ?? '')
  const [overridesByPreset, setOverridesByPreset] = useState<ParamOverrides>({})
  const [status, setStatus] = useState('')

  const selected = presets.find((preset) => preset.id === selectedId) ?? presets[0]
  const overrides = selected === undefined ? {} : overridesByPreset[selected.id] ?? {}
  const params = useMemo(
    () => (selected === undefined ? {} : normalizePresetParams(selected, overrides)),
    [selected, overrides],
  )
  const paramsKey = paramSignature(params)
  const program = programOf(doc, layer, typeId)
  const missingType = layer === 'behavior' && (typeId === undefined || typeId === '')

  // ------- 参数表达式实时校验（根/语法/函数白名单；路径留给插入后 lint 预览） -------
  const paramErrors = useMemo(() => {
    if (selected === undefined) return {} as Record<string, string>
    const roots = layer === 'flow' ? FLOW_ROOTS : BEHAVIOR_ROOTS
    const out: Record<string, string> = {}
    for (const param of selected.params) {
      if (param.type !== 'expr') continue
      const text = paramValueText(params[param.key]).trim()
      if (text === '') continue
      const checked = checkV4Expr(text, { roots, allowV4Functions: layer === 'flow' })
      if (!checked.ok) out[param.key] = checked.message
    }
    return out
  }, [selected, params, layer])
  const hasParamError = Object.keys(paramErrors).length > 0

  // ------- 展开 + 插入后校验预览（只展示本次展开节点引入的问题） -------
  const built = useMemo(() => {
    if (selected === undefined || missingType) return { ok: false as const, error: '' }
    try {
      // params 语义由 paramsKey 锁定（对象每次渲染新建）
      return { ok: true as const, result: buildPreset(selected.id, { doc, typeId }, params) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  }, [selected, doc, typeId, paramsKey, missingType])

  const previewIssues = useMemo(() => {
    if (!built.ok) return { errors: [] as string[], warnings: [] as string[] }
    try {
      const presetNodeIds = built.result.nodes.map((node) => node.id)
      const presetIds = new Set([...presetNodeIds, ...built.result.edges.map((edge) => edge.id)])
      const mentionsPreset = (message: string): boolean => [...presetIds].some((id) => message.includes(id))
      const previewDoc = applyPresetResultToDoc(doc, layer, typeId, built.result)
      // 结构/引用校验（V4_NODE/V4_REF/端口协议等）+ 语义 lint 合并预览；
      // 只保留「本次展开节点/连线」引入的问题（文档既有问题不属于预设责任）
      const structural = validateLevelDocV4(previewDoc)
      const lintIssues = lintLevelDocV4(previewDoc, {
        contractOf: (componentType) => {
          const contract = CONTRACTS.get(componentType)
          return contract === undefined
            ? undefined
            : { events: contract.events, commands: contract.commands, queries: contract.queries }
        },
      })
      const introduced = [...structural.errors, ...structural.warnings, ...lintIssues].filter(
        (issue) => (issue.nodeId !== undefined && presetIds.has(issue.nodeId)) || mentionsPreset(issue.message),
      )
      return {
        errors: [...new Set(introduced.filter((issue) => issue.level === 'error').map((issue) => issue.message))],
        warnings: [...new Set(introduced.filter((issue) => issue.level === 'warning').map((issue) => issue.message))],
      }
    } catch (err) {
      return { errors: [err instanceof Error ? err.message : String(err)], warnings: [] }
    }
  }, [built, doc, layer, typeId])

  // flow 预设依赖的 run 变量：只提示缺失项（画廊不代改文档，宿主/作者用变量面板补齐）
  const missingDeclarations = useMemo(() => {
    if (layer !== 'flow' || selected === undefined) return []
    const declared = new Set((doc.content.flow.vars ?? []).map((field) => field.key))
    return presetDeclarations(selected.id, params).filter((field) => !declared.has(field.key))
  }, [layer, selected, params, doc])

  const canInsert =
    selected !== undefined &&
    !missingType &&
    built.ok &&
    !hasParamError &&
    (layer === 'flow' || program !== undefined)

  const selectPreset = (presetId: string): void => {
    setSelectedId(presetId)
    setStatus('')
  }
  const updateParam = (key: string, value: Json): void => {
    if (selected === undefined) return
    setOverridesByPreset((current) => ({
      ...current,
      [selected.id]: { ...(current[selected.id] ?? {}), [key]: value },
    }))
  }
  const handleInsert = (): void => {
    if (selected === undefined || !canInsert || !built.ok) return
    try {
      const nodes = placeNodes(built.result.nodes, program)
      const result: PresetInsertResult = { nodes, edges: built.result.edges, presetId: selected.id }
      if (built.result.entryId !== undefined) result.entryId = built.result.entryId
      if (missingDeclarations.length > 0) result.declarations = missingDeclarations
      onInsert(result)
      setStatus(`已插入「${selected.name}」：${built.result.nodes.length} 个节点 / ${built.result.edges.length} 条连线`)
    } catch (err) {
      setStatus(`插入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (selected === undefined) {
    return (
      <section className="v4-preset-gallery" data-testid="v4-preset-gallery" data-layer={layer}>
        <div className="v4-preset-empty" data-testid="v4-preset-empty">
          当前层没有可用预设（{layer}）
        </div>
      </section>
    )
  }

  return (
    <section className="v4-preset-gallery" data-testid="v4-preset-gallery" data-layer={layer}>
      <header className="v4-preset-head">
        <b>预设画廊</b>
        <span className="v4-preset-head-hint">印章式节点组 · 插入后可改</span>
      </header>
      <div className="v4-preset-body">
        <ul className="v4-preset-list" data-testid="v4-preset-list">
          {presets.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                className={`v4-preset-item${preset.id === selected.id ? ' active' : ''}`}
                data-testid={`v4-preset-item-${preset.id}`}
                title={preset.description}
                onClick={() => selectPreset(preset.id)}
              >
                <span className="v4-preset-item-name">{preset.name}</span>
                <span className="v4-preset-item-layer">{preset.layer === 'flow' ? '流程' : '行为'}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="v4-preset-detail" data-testid="v4-preset-detail">
          <h4 className="v4-preset-title" data-testid="v4-preset-title">
            {selected.name}
          </h4>
          <p className="v4-preset-desc" data-testid="v4-preset-description">
            {selected.description}
          </p>

          {selected.params.length > 0 && (
            <div className="v4-preset-params" data-testid="v4-preset-params">
              {selected.params.map((param) => {
                const value = params[param.key]
                const error = paramErrors[param.key]
                const testId = `v4-preset-param-${param.key}`
                return (
                  <label key={param.key} className="v4-preset-param" data-testid={`${testId}-row`}>
                    <span className="v4-preset-param-label">{param.label}</span>
                    {param.type === 'select' ? (
                      <select
                        className="v4-preset-param-input"
                        data-testid={testId}
                        value={paramValueText(value)}
                        onChange={(event) => updateParam(param.key, event.target.value)}
                      >
                        {(param.options ?? []).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="v4-preset-param-input"
                        data-testid={testId}
                        type={param.type === 'number' ? 'number' : 'text'}
                        value={paramValueText(value)}
                        spellCheck={false}
                        onChange={(event) => updateParam(param.key, event.target.value)}
                      />
                    )}
                    {error !== undefined && (
                      <span className="v4-preset-param-error" data-testid={`${testId}-error`}>
                        {error}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          )}

          {missingType && (
            <div className="v4-preset-warning" data-testid="v4-preset-missing-type">
              行为预设需要先在「题型」页选择/新建一个题型（typeId）
            </div>
          )}
          {!built.ok && built.error !== '' && (
            <div className="v4-preset-warning" data-testid="v4-preset-build-error">
              {built.error}
            </div>
          )}
          {missingDeclarations.length > 0 && (
            <div className="v4-preset-hint" data-testid="v4-preset-declarations">
              该预设需要 run 变量：{missingDeclarations.map((field) => `v.${field.key}`).join('、')}
              （插入前可在流程变量面板补齐）
            </div>
          )}
          <div className="v4-preset-preview" data-testid="v4-preset-preview">
            {previewIssues.errors.length > 0 ? (
              <span className="v4-preset-preview-error">
                ⚠ 插入后校验：{previewIssues.errors.length} 个错误（{previewIssues.errors[0]}）
              </span>
            ) : previewIssues.warnings.length > 0 ? (
              <span className="v4-preset-preview-warn">✓ 插入后校验：{previewIssues.warnings.length} 个警告（不影响运行）</span>
            ) : (
              <span className="v4-preset-preview-ok">✓ 插入后校验无问题</span>
            )}
          </div>

          <div className="v4-preset-actions">
            <button
              type="button"
              className="primary"
              data-testid="v4-preset-insert"
              disabled={!canInsert}
              onClick={handleInsert}
            >
              插入到当前层
            </button>
            {status !== '' && (
              <span className="v4-preset-status" data-testid="v4-preset-status">
                {status}
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
