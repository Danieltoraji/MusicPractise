/**
 * 编辑器 AI 助手面板（批次1 ask 模式）：多轮对话面板。
 * 两种挂载形态共用本组件（docs/29）：编辑器右栏（其它 tab）与节点图工作台入坞（graph tab，
 * 处于 .graph-editor 主题作用域内随深浅换肤）；宽度均由外层容器决定。
 * 会话存 src/ai/session 模块级 store（按 doc.id），切 tab 卸载重挂不丢。
 * 只读工具（read_script/read_doc/read_json/lint/read_run_log），
 * 选中上下文由挂载方传入（graph：节点 id；script：选区；canvas：组件 id）。
 */
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toPng } from 'html-to-image'
import { EDITOR_HOOKS } from '../editorHooks'
import { runAgentTurn, stopAgent } from '../../ai/agent'
import { appendCapped, downscaleImage, fileToDataUrl, imageFilesFromClipboard, MAX_ATTACH_IMAGES } from '../../ai/imageAttach'
import { clearCheckpoint, getCheckpoint, saveCheckpoint } from '../../ai/checkpoint'
import type { AiProfileConfig, ChatMessage } from '../../ai/client'
import { buildEditorSystemPrompt, buildPlanExecutionPrompt, formatSelectionContext, PRESET_COMMANDS, type AiSelectionContext } from '../../ai/prompts'
import { appendMessage, clearSession, getSession, hydrateSession, patchSession, subscribeAiSession, type AiMode, type PlanItemStatus } from '../../ai/session'
import { buildPlan } from '../../ai/plan'
import type { PlanState } from '../../ai/plan'
import { loadAiSettings } from '../../ai/settings'
import { detectVision } from '../../ai/vision'
import { READONLY_TOOLS } from '../../ai/tools'
import { PLAN_TOOLS } from '../../ai/tools-plan'
import { DEBUG_TOOLS } from '../../ai/tools-debug'
import { WRITE_TOOLS } from '../../ai/tools-write'
import type { LevelDoc } from '../../engine/level'
import { DRAFT_SLOTS, loadDraft, saveDraft } from '../draftStore'

interface Props {
  doc: LevelDoc
  selection: AiSelectionContext
  onClose: () => void
  /**
   * 应用 AI 修改后的 doc（编辑器唯一写路径 update——全视图自动刷新+标脏）；agent 模式必经。
   * 第二参 tag 是该次 run 的独立撤销 tag（`ai:<n>`）：不同 run 不合并为一条撤销步（B6），
   * 回滚用 `rollback:<n>` 单独成步（F4：回滚可 Ctrl+Z）。缺省时编辑器回落旧 'ai' 合并语义。
   */
  onApplyDoc: (doc: LevelDoc, tag?: string) => void
  /**
   * 编辑器文档修订号（F1，docs/42 §4.3）：每次文档变更递增。agent 循环用它检测运行期间
   * 创作者的手动编辑——写入前修订号变了就拒绝写入并要求模型先重读。缺省 = 不做冲突检测。
   */
  getRevision?: () => number
  /**
   * 编辑器实时文档读取（R13 运行归属）：面板随切 Tab/调试布局卸载后 agent run 仍继续，
   * 读工具/懒检查点基线必须读编辑器实时 doc，而不是本面板最后一次渲染的快照。
   * 缺省回落 docRef（单测/旧挂载方式）。
   */
  getLiveDoc?: () => LevelDoc | null
  /** 节点图入坞形态：列内定高（列内非末位面板） */
  style?: React.CSSProperties
  /** 追加到根（drag-src 拖拽源半透明等） */
  className?: string
  /** 标题栏拖拽手柄（跨列槽移动，GraphEditor DnD 统一管理；可选） */
  headerDrag?: {
    onDragStart: () => void
    onDragEnd: () => void
    onDragOver: (e: React.DragEvent) => void
  }
}

function activeProfile(): AiProfileConfig | null {
  const s = loadAiSettings()
  const p = s.profiles[s.activeId]
  if (!p || !p.apiKey.trim() || !p.baseUrl.trim() || !p.model.trim()) return null
  return { baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey }
}

const MODE_META: Record<AiMode, { label: string; tip: string }> = {
  ask: { label: 'ask', tip: '只读问答：AI 可读取脚本/文档/校验/日志，不会修改关卡' },
  plan: { label: 'plan', tip: '规划模式：AI 调研后产出编号执行计划，确认后一键转 agent 执行' },
  agent: { label: 'agent', tip: '代理修改：AI 可直接修改关卡（首次写入前自动存检查点，可一键回滚）' },
}

/** token 用量显示：万位以上缩写为 k（万以下原样，保留可对账的精确感） */
function fmtTokens(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function AiPanel({ doc, selection, onClose, onApplyDoc, getRevision, getLiveDoc, style, className, headerDrag }: Props) {
  const session = useSyncExternalStore(subscribeAiSession, () => getSession(doc.id))
  // 工具 ctx 走 ref：agent 循环跨 await 期间始终读到最新 doc（保存副本换 id 会重挂面板，无碍）
  const docRef = useRef(doc)
  docRef.current = doc
  const applyRef = useRef(onApplyDoc)
  applyRef.current = onApplyDoc
  // B6（docs/40）：每次 run 独立撤销 tag——相邻两次 AI run 不再共用 'ai' 合并成一条撤销步；
  // 回滚用独立的 rollback:<n>（F4：Ctrl+Z 能撤销回滚本身）。runSeq 同时给两类 tag 发号。
  const runSeqRef = useRef(0)
  const runTagRef = useRef('ai')
  // 输入草稿跨 Tab 存活（docs/40 C1）：面板随 Tab 条件渲染卸载，草稿经 draftStore 保留
  const [input, setInput] = useState(() => loadDraft<string>(doc.id, DRAFT_SLOTS.aiInput) ?? '')
  useEffect(() => {
    saveDraft(doc.id, DRAFT_SLOTS.aiInput, input)
  }, [doc.id, input])
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const profile = activeProfile()

  // 会话持久化恢复（批次6b）：挂载时从 IndexedDB 载入本关卡的对话（内存为空才载入）
  useEffect(() => {
    void hydrateSession(doc.id)
  }, [doc.id])

  // R5 运行归属（docs/42 §4.4）：卸载/切 Tab **不再** abort agent 循环——面板在节点图调试布局
  // 下会随布局切换卸载，AI 启动调试后切走或拖拽 dock 不应打断自己的 run（docs/28「全 tab 常驻」）。
  // 显式停止归宿主：EditorPage 在关闭面板/离开编辑器/内置副本保存时 stopAgent（W1 收口）；
  // 本面板只保留「停止」按钮。工具写通道经 applyRef 指向宿主 update，面板卸载后写入依然落地。

  // 新消息/状态变化时滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.messages.length, session.busy, session.error])

  // AI 新建关卡开场（批次4）：资源库写入的 kickoff 指令 → 本 doc 首次挂载时自动以 agent 开工
  // 键按 docId 键控（docs/40 C6）：跨挂载残留只影响同 id 的面板，不会错显/覆盖其它关卡
  useEffect(() => {
    const key = `ai-kickoff:${doc.id}`
    const raw = sessionStorage.getItem(key)
    if (!raw) return
    try {
      const kickoff = JSON.parse(raw) as { docId: string; prompt: string }
      if (kickoff.docId !== doc.id || !kickoff.prompt.trim()) return
      sessionStorage.removeItem(key)
      patchSession(doc.id, { mode: 'agent' })
      if (!activeProfile()) {
        setInput(kickoff.prompt.trim()) // 未配置 Key：先填入输入框，配置后一键发送
        return
      }
      void sendText(kickoff.prompt.trim())
    } catch {
      sessionStorage.removeItem(key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id])

  /** 附图进列（📎 上传与粘贴共用）：逐张压缩、容量截断；单张失败跳过不挡其余 */
  const attachFiles = async (files: Iterable<File>): Promise<void> => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      try {
        const small = await downscaleImage(await fileToDataUrl(file))
        setPendingImages((prev) => appendCapped(prev, small))
      } catch {
        // 读取/解码失败的单张跳过
      }
    }
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if ((!text && pendingImages.length === 0) || session.busy) return
    await sendText(text, pendingImages)
  }

  /** 本轮请求的公共参数（sendText 与失败重试共用；工具集/截图/轮数随模式取） */
  const turnOptions = (mode: AiMode, prof: AiProfileConfig) => ({
    docId: doc.id,
    profile: prof,
    // 函数形态:agent 循环每轮以「运行内最新 doc」现算——中途新增组件的事件/命令清单当轮即可见
    systemPrompt: (doc: LevelDoc) => buildEditorSystemPrompt(doc, mode),
    tools:
      mode === 'agent'
        ? [
            ...READONLY_TOOLS,
            ...WRITE_TOOLS,
            ...DEBUG_TOOLS,
            ...(getSession(doc.id).plan?.status === 'executing' ? PLAN_TOOLS : []),
          ]
        : READONLY_TOOLS,
    ctx: {
      // R13：优先读编辑器实时 doc（面板卸载后 run 继续时快照已过期）；同 id 才采信
      getDoc: () => {
        const live = getLiveDoc?.()
        return live && live.id === doc.id ? live : docRef.current
      },
      applyDoc: (next: LevelDoc) => {
        // F14（docs/42 §5.1）：检查点懒存——只在 agent 模式「第一次真正 AI 写入」前快照。
        // 纯问答/计划生成不产生检查点；已有检查点（本次任务基线）不重复覆盖，计划/续跑保留基线。
        const cur = getSession(doc.id)
        if (cur.mode === 'agent' && cur.checkpointAt === null) {
          const live = getLiveDoc?.()
          const at = saveCheckpoint(doc.id, live && live.id === doc.id ? live : docRef.current)
          patchSession(doc.id, { checkpointAt: at })
        }
        applyRef.current(next, runTagRef.current)
      },
      // F1：修订号真源透传给 agent 循环（缺省 undefined = 该宿主未提供修订号，不做冲突检测）
      getRevision,
      levelId: doc.id,
      // AI 截图（批次8b/9 目标）：graph=节点卡层（纯 HTML，避开 React Flow SVG 的已知捕获问题）；
      // canvas=编辑器画布的关卡预览；debug=调试运行的游玩画面（.gdb-stage-canvas，无可见会话时无此元素）
      captureScreenshot: async (target: 'graph' | 'canvas' | 'debug' = 'graph') => {
        const el =
          target === 'canvas'
            ? document.querySelector(`.${EDITOR_HOOKS.editorBody} .${EDITOR_HOOKS.editorCanvas}`)
            : target === 'debug'
              ? document.querySelector(`.${EDITOR_HOOKS.debugStageCanvas}`)
              : document.querySelector(`.${EDITOR_HOOKS.graphNodes}`) ??
                document.querySelector(`.${EDITOR_HOOKS.graphFlow}`)
        if (!el) return null
        try {
          const capture = toPng(el as HTMLElement, {
            backgroundColor: target === 'canvas' ? '#f3f5f8' : '#14181f',
            pixelRatio: 1.5,
            skipFonts: true,
          })
          return await Promise.race([
            capture,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
          ])
        } catch {
          return null
        }
      },
    },
    maxTurns: mode === 'agent' ? 32 : 8,
    stream: true,
  })

  /** 实际发送（send 的内 guts；执行计划/开场自动发送复用）。mode 直读 store 真源（executePlan 先切模式再发送，快照会滞后） */
  const sendText = async (text: string, images?: string[]): Promise<void> => {
    if ((!text && !(images && images.length > 0)) || session.busy) return
    const prof = profile ?? activeProfile()
    if (!prof) return
    const mode = getSession(doc.id).mode
    setInput('')
    setPendingImages([])
    // B6：每次 run 独立撤销 tag（不同 run 的写入不合并成一条撤销步）；
    // F14：检查点不在这里存——懒存于本次 run 第一次真正写入之前
    runTagRef.current = `ai:${++runSeqRef.current}`
    const ctxText = formatSelectionContext(selection, docRef.current)
    const body = text || '（见图片）'
    const userText = ctxText ? `[上下文] ${ctxText}\n\n${body}` : body
    await runAgentTurn({ ...turnOptions(mode, prof), userText, images: images && images.length > 0 ? images : undefined })
  }

  /** 失败重试（批次8c）：不重复插入刚才的消息，以现有历史续跑本轮；检查点仍是懒存（首次写入前） */
  const retry = async (): Promise<void> => {
    if (session.busy || !session.error) return
    const prof = profile ?? activeProfile()
    if (!prof) return
    const mode = getSession(doc.id).mode
    patchSession(doc.id, { error: null })
    runTagRef.current = `ai:${++runSeqRef.current}`
    await runAgentTurn(turnOptions(mode, prof))
  }

  /** 撞限续跑：上次运行到轮数上限未完，以现有历史接着跑（预算重置；检查点不动——保留任务前基线供 ↩ 回滚） */
  const continueAfterCap = async (): Promise<void> => {
    if (session.busy || !session.turnCapHit) return
    const prof = profile ?? activeProfile()
    if (!prof) return
    patchSession(doc.id, { turnCapHit: false })
    runTagRef.current = `ai:${++runSeqRef.current}`
    await runAgentTurn(turnOptions(getSession(doc.id).mode, prof))
  }

  /** plan 模式确认流：解析最近回复为计划清单（不可解析回退纯文本执行条） */
  const lastAssistantText = useMemo(() => {
    if (session.mode !== 'plan' || session.busy) return null
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]
      if (m.role === 'user') return null
      if (m.role === 'assistant' && m.content.trim() !== '') return m.content
    }
    return null
  }, [session.mode, session.busy, session.messages])
  const draftPlan = useMemo(() => (lastAssistantText === null ? null : buildPlan(lastAssistantText)), [lastAssistantText])
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => {
    setExcluded(new Set()) // 新计划生成时重置勾选
  }, [lastAssistantText])

  const executePlan = async (): Promise<void> => {
    if (session.busy) return
    // 结构化计划：按勾选组装（排除项标 skipped 不下发）；回退：纯文本计划
    if (draftPlan) {
      const items = draftPlan.items.map((it, i) => (excluded.has(i) ? { ...it, status: 'skipped' as const } : it))
      const enabled = items.filter((it) => it.status !== 'skipped')
      if (enabled.length === 0) return
      // F14：执行计划不再预先存检查点——真写入时才懒存基线
      patchSession(doc.id, { mode: 'agent', plan: { ...draftPlan, items, status: 'executing' } })
      await sendText(buildPlanExecutionPrompt(enabled))
      return
    }
    if (!lastAssistantText || session.busy) return
    // F14：回退纯文本计划同样懒存检查点
    patchSession(doc.id, { mode: 'agent' })
    await sendText(`请严格按以下计划执行修改（不要重新规划，逐项落实后汇报结果）：\n\n${lastAssistantText}`)
  }

  /** plan-act 继续：恢复的 executing 计划重发未完成项 */
  const continuePlan = async (): Promise<void> => {
    const plan = getSession(doc.id).plan
    if (!plan || plan.status !== 'executing' || session.busy) return
    const remaining = plan.items.filter((it) => it.status === 'pending' || it.status === 'in_progress')
    if (remaining.length === 0) return
    // F14：继续执行不再重存检查点（保留任务前基线供单级回滚）
    await sendText(buildPlanExecutionPrompt(remaining))
  }

  const abandonPlan = (): void => {
    patchSession(doc.id, { plan: null, mode: 'ask' })
  }

  const rollback = (): void => {
    const cp = getCheckpoint(doc.id)
    if (!cp || session.busy) return
    // F4（docs/40）：回滚 = 整文档覆盖，会连带撤销检查点之后的全部手工修改——
    // 二次确认 + 影响摘要；执行中的计划一并复位。回滚经 applyRef → update 入撤销栈（可 Ctrl+Z）
    const cur = docRef.current
    const diff = (a: unknown[] | undefined, b: unknown[] | undefined): string => `${a?.length ?? 0}→${b?.length ?? 0}`
    const summary = cur
      ? `组件 ${diff(cur.content.components, cp.doc.content.components)} · 逻辑节点 ${diff(cur.content.logic.nodes, cp.doc.content.logic.nodes)} · 表行 ${diff(cur.content.table.rows, cp.doc.content.table.rows)}`
      : ''
    if (!window.confirm(`回滚到检查点（${new Date(cp.at).toLocaleTimeString()}）？这将覆盖检查点之后的全部修改（含手工编辑）：${summary}`)) return
    // F4：回滚用独立 rollback:<n> tag——不与 AI 写入的 tag 合并，Ctrl+Z 可撤销回滚本身
    applyRef.current(cp.doc, `rollback:${++runSeqRef.current}`)
    appendMessage(doc.id, {
      role: 'assistant',
      content: `↩ 已回滚到 AI 修改前的版本（检查点 ${new Date(cp.at).toLocaleTimeString()}；${summary}）。可用 Ctrl+Z 撤销本次回滚。`,
    })
    clearCheckpoint(doc.id)
    patchSession(doc.id, { checkpointAt: null, plan: null })
  }

  const empty = session.messages.length === 0

  return (
    <aside className={`ai-panel${className ? ` ${className}` : ''}`} style={style} data-testid="ai-panel">
      <div
        className={`ai-panel-head${headerDrag ? ' is-draggable' : ''}`}
        draggable={!!headerDrag}
        title={headerDrag ? 'AI 助手：拖动标题栏可移动到其它列或调整顺序' : undefined}
        onDragStart={() => headerDrag?.onDragStart()}
        onDragEnd={() => headerDrag?.onDragEnd()}
        onDragOver={(e) => headerDrag?.onDragOver(e)}
      >
        <b>AI 助手</b>
        <span className="ai-mode-tabs" role="tablist">
          {(Object.keys(MODE_META) as AiMode[]).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`ai-mode-tab-${m}`}
              className={`ai-mode-tab${session.mode === m ? ' active' : ''}`}
              title={MODE_META[m].tip}
              disabled={session.busy || session.mode === m}
              onClick={() => patchSession(doc.id, { mode: m, checkpointAt: m === 'ask' ? null : session.checkpointAt, turnCapHit: false })}
            >
              {MODE_META[m].label}
            </button>
          ))}
        </span>
        {session.checkpointAt !== null && (
          <button
            type="button"
            data-testid="ai-rollback"
            className="ai-panel-rollback"
            title="撤销本轮 AI 的全部修改：恢复到 agent 模式发送前的版本"
            onClick={rollback}
            disabled={session.busy}
          >
            ↩ 回滚
          </button>
        )}
        <button
          type="button"
          className="ai-panel-clear"
          onClick={() => clearSession(doc.id)}
          disabled={session.busy || empty}
          title="清空本关卡的对话记录"
        >
          清空
        </button>
        <button type="button" className="ai-panel-close" title="收起面板" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="ai-panel-msgs" ref={listRef}>
        {empty && !session.error && (
          <div className="ai-panel-empty">
            <p>问点什么（点击即填入输入框）：</p>
            <ul>
              {(session.mode === 'agent'
                ? [
                    '把过关条件改成 v.score >= 60',
                    '再加 3 道选择题（数据表加行 + 逻辑改判定）',
                    '帮我检查并修复这个关卡的问题，然后试运行验证',
                  ]
                : [
                    '这个关卡的逻辑是怎么走的？',
                    '帮我检查有没有悬空引用或类型问题',
                    '试运行报错了，帮我看看日志（先点「▶ 试运行」）',
                  ]
              ).map((q) => (
                <li key={q}>
                  <button type="button" className="ai-preset" disabled={session.busy} onClick={() => setInput(q)}>
                    {q}
                  </button>
                </li>
              ))}
            </ul>
            <p className="muted">
              {session.mode === 'agent'
                ? 'agent 模式：AI 会直接修改关卡（每次写入都过校验；首次写入前已存检查点，可随时「↩ 回滚」）。'
                : session.mode === 'plan'
                  ? 'plan 模式：AI 调研后产出编号执行计划，确认后一键转 agent 执行。'
                  : 'AI 可读取脚本、文档、校验结果与运行日志。先在画布/节点图/脚本页选中一个元素再提问，会自动附带上下文。'}
            </p>
          </div>
        )}
        {session.messages.map((m, i) => renderMsg(m, i))}
        {session.busy && <p className="muted ai-msg ai-busy">思考中…</p>}
      </div>

      {session.plan && session.plan.status !== 'draft' && (
        <PlanCard
          plan={session.plan}
          onAbandon={session.plan.status === 'executing' && !session.busy ? abandonPlan : undefined}
          onContinue={session.plan.status === 'executing' && !session.busy ? () => void continuePlan() : undefined}
        />
      )}
      {!session.plan && draftPlan && (
        <div className="ai-plan-card" data-testid="ai-plan-card">
          <div className="ai-plan-head">
            <span>执行计划（{draftPlan.items.length} 项）——勾选要执行的项</span>
            <button
              type="button"
              data-testid="ai-plan-run"
              className="ai-plan-run"
              disabled={excluded.size === draftPlan.items.length}
              onClick={() => void executePlan()}
            >
              ▶ 执行计划
            </button>
            <button
              type="button"
              data-testid="ai-plan-abandon"
              className="ai-plan-abandon"
              title="放弃这份计划"
              onClick={() => setExcluded(new Set(draftPlan.items.map((_, i) => i)))}
            >
              放弃
            </button>
          </div>
          <div className="ai-plan-items" data-testid="ai-plan-items">
            {draftPlan.items.map((it, i) => (
              <label key={i} className="ai-plan-item">
                <input
                  type="checkbox"
                  checked={!excluded.has(i)}
                  onChange={(e) =>
                    setExcluded((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.delete(i)
                      else next.add(i)
                      return next
                    })
                  }
                />
                <span>{it.text}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {!session.plan && !draftPlan && lastAssistantText && session.mode === 'plan' && !session.busy && (
        <div className="ai-plan-bar" data-testid="ai-plan-bar">
          <span>上方回复包含执行计划</span>
          <button type="button" className="ai-plan-run" data-testid="ai-plan-run" onClick={() => void executePlan()}>
            ▶ 执行计划
          </button>
        </div>
      )}

      {session.turnCapHit && !session.busy && (
        <div className="ai-panel-capbar" data-testid="ai-capbar">
          <span>已达单次任务轮数上限，任务还没跑完？</span>
          <button
            type="button"
            data-testid="ai-cap-run"
            className="ai-panel-cap-run"
            title="以现有进度接着跑（轮数预算重置，不重复发消息）"
            disabled={!profile}
            onClick={() => void continueAfterCap()}
          >
            ▶ 继续
          </button>
          <button type="button" className="ai-panel-error-close" data-testid="ai-cap-close" title="关闭" onClick={() => patchSession(doc.id, { turnCapHit: false })}>
            ×
          </button>
        </div>
      )}

      {session.error && (
        <div className="ai-panel-error" data-testid="ai-error">
          <span>{session.error}</span>
          <button
            type="button"
            data-testid="ai-error-retry"
            className="ai-panel-error-retry"
            title="以现有对话重跑本轮（不重复发送刚才的消息）"
            disabled={session.busy || !profile}
            onClick={() => void retry()}
          >
            ↻ 重试
          </button>
          <button type="button" className="ai-panel-error-close" data-testid="ai-error-close" title="关闭" onClick={() => patchSession(doc.id, { error: null })}>
            ×
          </button>
        </div>
      )}
      {!profile && (
        <p className="ai-panel-hint">
          尚未配置 AI 供应商——<a href="#/settings">前往设置</a> 填入 API Key 后即可使用。
        </p>
      )}

      {!session.busy && profile && (
        <div className="ai-presets">
          {PRESET_COMMANDS.map((p) => (
            <button
              key={p.key}
              type="button"
              title={p.tip}
              onClick={() => {
                patchSession(doc.id, { mode: p.mode })
                void sendText(p.instruction)
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {pendingImages.length > 0 && (
        <div className="ai-attach-row">
          {pendingImages.map((src, i) => (
            <span key={i} className="ai-attach-chip">
              <img src={src} alt={`附图 ${i + 1}`} />
              <button
                type="button"
                className="ai-attach-del"
                title="移除这张图"
                onClick={() => setPendingImages((prev) => prev.filter((_, k) => k !== i))}
              >
                ×
              </button>
            </span>
          ))}
          {profile && detectVision(profile.model) === 'text' && (
            <span className="ai-attach-warn" title="该模型名属于已知纯文本模型，附图可能被供应商拒绝（4xx）。可在设置中改用视觉模型">
              ⚠ 当前模型可能不支持图像输入
            </span>
          )}
        </div>
      )}

      <div className="ai-panel-form" data-testid="ai-form">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void attachFiles(e.target.files ?? [])
            e.target.value = ''
          }}
        />
        <button
          type="button"
          data-testid="ai-attach"
          className="ai-attach-btn"
          title={`附加图片（也可直接 Ctrl+V 粘贴截图，最多 ${MAX_ATTACH_IMAGES} 张）`}
          disabled={!profile || pendingImages.length >= MAX_ATTACH_IMAGES}
          onClick={() => fileInputRef.current?.click()}
        >
          📎
        </button>
        <textarea
          data-testid="ai-input"
          rows={2}
          placeholder={
            profile
              ? session.mode === 'agent'
                ? '让 AI 修改关卡…（Enter 发送；首次写入前自动存检查点）'
                : '询问当前关卡…（Enter 发送，Shift+Enter 换行；可粘贴截图提问）'
              : '请先在设置中配置 AI 供应商'
          }
          value={input}
          disabled={!profile}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            if (!profile) return
            const items = e.clipboardData?.items
            if (!items) return
            const files = imageFilesFromClipboard(items)
            if (files.length === 0) return
            e.preventDefault()
            void attachFiles(files)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {session.busy ? (
          <button type="button" data-testid="ai-stop" onClick={() => stopAgent(doc.id)}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            data-testid="ai-send"
            disabled={!profile || (!input.trim() && pendingImages.length === 0)}
            onClick={() => void send()}
          >
            发送
          </button>
        )}
      </div>

      {(session.usage || (session.turnCount ?? 0) > 0) && (
        <div
          data-testid="ai-usage"
          className="ai-panel-usage"
          title="本会话累计 token 用量与本轮请求轮数（轮数在每次运行开始归零）"
        >
          {session.usage && (
            <>
              ↑{fmtTokens(session.usage.promptTokens)} ↓{fmtTokens(session.usage.completionTokens)} tokens
            </>
          )}
          {session.usage && (session.turnCount ?? 0) > 0 && ' · '}
          {(session.turnCount ?? 0) > 0 && <>本轮 {session.turnCount} 轮</>}
        </div>
      )}
    </aside>
  )
}

/** 计划卡（executing/done）：逐项状态实时显示（update_plan 工具驱动）；恢复的 executing 可继续执行 */
function PlanCard({
  plan,
  onAbandon,
  onContinue,
}: {
  plan: PlanState
  onAbandon?: () => void
  onContinue?: () => void
}) {
  const done = plan.items.filter((it) => it.status === 'done' || it.status === 'skipped').length
  const icon = (s: PlanItemStatus): string =>
    s === 'done' ? '✓' : s === 'in_progress' ? '→' : s === 'skipped' ? '—' : '○'
  return (
    <div className="ai-plan-card" data-testid="ai-plan-card">
      <div className="ai-plan-head">
        <span>
          {plan.status === 'done' ? '✅ 计划完成' : `⚙ 执行计划中（${done}/${plan.items.length}）`}
        </span>
        {onContinue && (
          <button type="button" className="ai-plan-run" data-testid="ai-plan-run" title="重发未完成的计划项" onClick={onContinue}>
            ▶ 继续执行
          </button>
        )}
        {onAbandon && (
          <button type="button" className="ai-plan-abandon" data-testid="ai-plan-abandon" title="放弃计划（已执行的修改用「↩ 回滚」撤销）" onClick={onAbandon}>
            放弃
          </button>
        )}
      </div>
      <div className="ai-plan-items" data-testid="ai-plan-items">
        {plan.items.map((it, i) => (
          <div key={i} className={`ai-plan-item st-${it.status}`}>
            <span className="ai-plan-icon">{icon(it.status)}</span>
            <span className={it.status === 'skipped' ? 'muted' : ''}>{it.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 定稿 assistant 消息的 Markdown 渲染（GFM 表格/删除线；默认不渲染原始 HTML——无 XSS 面） */
const mdComponents = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noreferrer" />
  ),
}

const MarkdownView = memo(function MarkdownView({ text }: { text: string }) {
  return (
    <div className="ai-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

function renderMsg(m: ChatMessage, i: number): React.ReactNode {
  const images =
    m.images && m.images.length > 0 ? (
      <div className="ai-msg-images">
        {m.images.map((src, k) => (
          <img key={k} src={src} alt={`截图 ${k + 1}`} />
        ))}
      </div>
    ) : null
  if (m.role === 'user') {
    return (
      <div key={i} className="ai-msg ai-msg-user">
        {m.content}
        {images}
      </div>
    )
  }
  if (m.role === 'assistant') {
    // 流式中：纯文本 + 光标（避免半截 markdown 反复解析）；定稿：markdown 渲染 + 超长内滚
    if (m.streaming) {
      return (
        <div key={i} className="ai-msg ai-msg-assistant">
          {m.toolCalls && m.toolCalls.length > 0 && (
            <div className="ai-tool-calls">⚙ 调用工具：{m.toolCalls.map((c) => c.function.name).join('、')}</div>
          )}
          <span>{m.content}</span>
          <span className="ai-cursor" aria-hidden />
        </div>
      )
    }
    return (
      <div key={i} className="ai-msg ai-msg-assistant ai-msg-md">
        {m.toolCalls && m.toolCalls.length > 0 && (
          <div className="ai-tool-calls">⚙ 调用工具：{m.toolCalls.map((c) => c.function.name).join('、')}</div>
        )}
        <MarkdownView text={m.content} />
      </div>
    )
  }
  return (
    <details key={i} className="ai-msg ai-msg-tool" open={!!images}>
      <summary>⚙ {m.name ?? '工具'} 结果</summary>
      {images}
      <pre>{m.content}</pre>
    </details>
  )
}

export default AiPanel
