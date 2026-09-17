import { describe, expect, it } from 'vitest'
import { LogicEngine, type LogicHost, type LogicProgram } from './logic'
import type { Json } from './expr'

function makeHost(question: Json | null = null): { host: LogicHost; commands: { path: string; args: Json }[] } {
  const commands: { path: string; args: Json }[] = []
  return {
    commands,
    host: {
      getQuestion: () => question,
      dispatchCommand: (path, args) => commands.push({ path, args }),
    },
  }
}

describe('LogicEngine', () => {
  it('事件命中 when 条件走 do 分支', () => {
    const { host, commands } = makeHost({ data: { answerMidi: 64, reward: [1, 2, 3] }, scoring: { max: 10 } })
    const program: LogicProgram = {
      variables: { score: 0 },
      rules: [
        {
          id: 'r1',
          on: 'staff1.noteClicked',
          when: ['event.midi == q.data.answerMidi'],
          do: [
            { cmd: 'sound1.play', args: { notes: '$q.data.reward' } },
            { set: 'score', expr: 'v.score + q.scoring.max' },
          ],
          else: [{ set: 'score', expr: 'v.score - 1' }],
        },
      ],
    }
    const engine = new LogicEngine(program, host)
    engine.dispatch('staff1.noteClicked', { midi: 64 })
    expect(commands).toEqual([{ path: 'sound1.play', args: { notes: [1, 2, 3] } }])
    expect(engine.vars.score).toBe(10)

    engine.dispatch('staff1.noteClicked', { midi: 65 })
    expect(engine.vars.score).toBe(9)
  })

  it('emit 内部级联触发其它规则', () => {
    const { host, commands } = makeHost(null)
    const program: LogicProgram = {
      rules: [
        { id: 'a', on: 'x.y', do: [{ emit: 'z:w', payload: { n: 1 } }] },
        { id: 'b', on: 'z:w', when: ['event.n == 1'], do: [{ cmd: 'side.effect', args: { ok: true } }] },
      ],
    }
    new LogicEngine(program, host).dispatch('x.y')
    expect(commands).toEqual([{ path: 'side.effect', args: { ok: true } }])
  })

  it('$expr: 与 $event. 引用深度解析', () => {
    const { host, commands } = makeHost(null)
    const program: LogicProgram = {
      rules: [
        {
          id: 'a',
          on: 'x.y',
          do: [
            { cmd: 'label.show', args: { text: '$expr:\'分: \' + event.score' } },
            { cmd: 'h.mark', args: { target: '$event.midi' } },
          ],
        },
      ],
    }
    new LogicEngine(program, host).dispatch('x.y', { score: 7, midi: 60 })
    expect(commands).toEqual([
      { path: 'label.show', args: { text: '分: 7' } },
      { path: 'h.mark', args: { target: 60 } },
    ])
  })

  it('resolve 只认合法引用形态，其余保持字面量', () => {
    const { host } = makeHost({ data: { x: 42 } })
    const engine = new LogicEngine({ rules: [] }, host)
    expect(engine.resolve('$100')).toBe('$100')
    expect(engine.resolve('$foo.bar')).toBe('$foo.bar')
    expect(engine.resolve('$q.data.x')).toBe(42)
    expect(engine.resolve({ a: ['$q.data.x', 'plain$'] })).toEqual({ a: [42, 'plain$'] })
  })

  it('死循环被级联预算拦截', () => {
    let errors: unknown[] = []
    const host: LogicHost = {
      getQuestion: () => null,
      dispatchCommand: () => {},
      onError: (e) => errors.push(e),
    }
    const program: LogicProgram = {
      rules: [
        { id: 'a', on: 'e1', do: [{ emit: 'e2' }] },
        { id: 'b', on: 'e2', do: [{ emit: 'e1' }] },
      ],
    }
    new LogicEngine(program, host).dispatch('e1')
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toMatch(/预算/)
  })

  it('表达式语法错误被 lint 发现；set 未声明变量一并报出', () => {
    const errors = LogicEngine.lint({
      rules: [{ id: 'r', on: 'x', do: [{ set: 'a', expr: '1 +' }] }],
    })
    expect(errors.length).toBe(2) // 语法错误 + set 未声明变量
    expect(errors.some((e) => e.includes('未声明变量'))).toBe(true)
  })

  it('lint 的 extraVariableKeys 豁免题目 logicPatch 声明的变量', () => {
    const program = { rules: [{ id: 'r', on: 'x', do: [{ set: 'answered', expr: 'true' }] }] }
    expect(LogicEngine.lint(program).length).toBe(1)
    expect(LogicEngine.lint(program, { extraVariableKeys: ['answered'] }).length).toBe(0)
  })

  it('级联中途 reset 作废剩余旧队列（restart 边界加固）', () => {
    let engineRef: LogicEngine | null = null
    const { host, commands } = makeHost(null)
    const wrappedHost: LogicHost = {
      ...host,
      dispatchCommand: (path) => {
        if (path === 'level.restart') engineRef!.reset()
      },
    }
    const engine = new LogicEngine(
      {
        variables: { touched: false },
        rules: [
          { id: 'r1', on: 'e1', do: [{ emit: 'e2' }, { emit: 'e3' }] },
          { id: 'r2', on: 'e2', do: [{ cmd: 'level.restart' }] },
          { id: 'r3', on: 'e3', do: [{ set: 'touched', expr: 'true' }] },
        ],
      },
      wrappedHost,
    )
    engineRef = engine
    engine.dispatch('e1')
    expect(engine.vars.touched).toBe(false) // e3 已随 reset 作废
    expect(commands).toHaveLength(0)
  })

  it('reset 恢复变量初值且保持对象身份（级联中途 restart 不丢同批写入）', () => {
    const { host } = makeHost(null)
    const engine = new LogicEngine({ variables: { score: 0 }, rules: [{ id: 'r', on: 'x', do: [{ set: 'score', expr: '99' }] }] }, host)
    const ref = engine.vars
    engine.dispatch('x')
    expect(engine.vars.score).toBe(99)
    engine.reset()
    expect(engine.vars).toBe(ref) // 身份不变：级联中捕获的旧引用依然有效
    expect(engine.vars.score).toBe(0)
  })
})
