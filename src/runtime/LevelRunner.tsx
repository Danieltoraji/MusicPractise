/**
 * 关卡运行器：装载关卡文档 → 实例化组件 → 驱动逻辑引擎 → 生命周期事件。
 * 运行器只做流程（装载题目/下一题/结算），一切判定规则都在关卡 JSON 里。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LevelDoc, Question } from '../engine/level'
import type { Json } from '../engine/expr'
import { LogicEngine } from '../engine/logic'
import { ComponentStore } from './store'
import { getCtx, playNotes } from './audio'
import { ComponentView } from '../components/views'

interface Runtime {
  store: ComponentStore
  emitFor(id: string): (event: string, payload?: Json) => void
  start(): void
}

export function LevelRunner({ doc }: { doc: LevelDoc }) {
  const [runKey, setRunKey] = useState(0)
  return <RunnerCore key={runKey} doc={doc} onRetry={() => setRunKey((k) => k + 1)} />
}

function RunnerCore({ doc, onRetry }: { doc: LevelDoc; onRetry: () => void }) {
  const questionRef = useRef<Question | null>(null)
  const finishedRef = useRef(false)
  const [progress, setProgress] = useState({ index: 0, total: doc.content.questions.length })
  const [finished, setFinished] = useState<{ score: Json; passed: boolean } | null>(null)

  const rt = useMemo<Runtime>(() => {
    const content = doc.content
    const store = new ComponentStore()
    store.init(content.components)

    let order = content.questions.map((_, i) => i)
    if (content.flow?.order === 'shuffle') {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[order[i], order[j]] = [order[j], order[i]]
      }
    }
    if (typeof content.flow?.count === 'number') order = order.slice(0, content.flow.count)

    let pos = 0
    let engine: LogicEngine

    const loadQuestion = (p: number): void => {
      pos = p
      const q = content.questions[order[p]] ?? null
      questionRef.current = q
      for (const comp of content.components) {
        if (!comp.bindings) continue
        for (const [key, raw] of Object.entries(comp.bindings)) {
          try {
            store.applyBinding(comp.id, key, engine.resolve(raw))
          } catch (err) {
            console.error(`[runner] 绑定解析失败 ${comp.id}.${key}:`, raw, err)
          }
        }
      }
      setProgress({ index: p, total: order.length })
      engine.dispatch('level.questionLoaded', { index: p, total: order.length })
    }

    const finish = (): void => {
      let passed = true
      if (content.flow?.pass?.expr) passed = Boolean(engine.evaluate(content.flow.pass.expr))
      finishedRef.current = true
      const score = engine.vars.score ?? 0
      setFinished({ score, passed })
      engine.dispatch('level.finished', { score, passed })
    }

    const start = (): void => {
      engine.dispatch('level.started', { title: String(doc.meta.title ?? '') })
      loadQuestion(0)
    }

    const restart = (): void => {
      engine.reset()
      store.resetAll()
      finishedRef.current = false
      setFinished(null)
      start()
    }

    const handleCommand = (path: string, args: Json): void => {
      const dot = path.indexOf('.')
      if (dot <= 0) return
      const cid = path.slice(0, dot)
      const cmd = path.slice(dot + 1)
      if (cid === 'level') {
        if (cmd === 'next') {
          if (!finishedRef.current && pos + 1 < order.length) loadQuestion(pos + 1)
          else finish()
        } else if (cmd === 'restart') {
          restart()
        }
        return
      }
      try {
        const effects = store.applyCommand(cid, cmd, args as Record<string, Json>)
        for (const eff of effects) {
          if (eff.type === 'audio.play') playNotes(eff.notes, eff.tempo)
        }
      } catch (err) {
        console.error(`[runner] 命令执行失败 ${path}:`, err)
      }
    }

    engine = new LogicEngine(content.logic, {
      getQuestion: () => questionRef.current as unknown as Json,
      dispatchCommand: handleCommand,
      getNowSeconds: () => getCtx().currentTime,
      onError: (err, where) => console.error('[logic]', where, err),
    })

    const emitFns = new Map<string, (event: string, payload?: Json) => void>()
    const emitFor = (id: string): ((event: string, payload?: Json) => void) => {
      let fn = emitFns.get(id)
      if (!fn) {
        fn = (event, payload) => engine.dispatch(`${id}.${event}`, payload ?? {})
        emitFns.set(id, fn)
      }
      return fn
    }

    const lintWarnings = LogicEngine.lint(content.logic)
    if (lintWarnings.length > 0) console.warn('[runner] 逻辑 lint 告警:', lintWarnings)

    return { store, emitFor, start }
  }, [doc])

  useEffect(() => {
    rt.start()
  }, [rt])

  const currentQuestion = questionRef.current

  return (
    <div className="level-runner">
      <div className="level-head">
        <span className="level-title">{String(doc.meta.title ?? '未命名关卡')}</span>
        {currentQuestion?.prompt?.text && <span className="level-prompt">{currentQuestion.prompt.text}</span>}
        <span className="level-progress">
          第 {Math.min(progress.index + 1, progress.total)} / {progress.total} 题
        </span>
      </div>
      <div className="level-canvas-wrap">
        <div className="level-canvas">
          {doc.content.components.map((c) => (
            <ComponentView key={c.id} spec={c} store={rt.store} emit={rt.emitFor(c.id)} />
          ))}
        </div>
      </div>
      <div className="level-foot">
        {finished ? (
          <span className={finished.passed ? 'pass' : 'nopass'}>
            已完成 · 得分 {String(finished.score)} · {finished.passed ? '通过 🎉' : '未通过'}
          </span>
        ) : (
          <button type="button" className="link" onClick={onRetry}>
            重开本关
          </button>
        )}
      </div>
    </div>
  )
}
