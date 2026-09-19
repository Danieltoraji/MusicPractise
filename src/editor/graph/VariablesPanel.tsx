/**
 * 变量面板（左栏底部）：变量的增删改，走 graphProgram 版函数
 * （rename 同步改写 assign.target；表达式旧引用不改写，由 lint 红标提示）。
 */
import { useState } from 'react'
import type { GraphProgram } from '../../engine/graphProgram'
import type { Json } from '../../engine/expr'
import { parseScalarInput } from '../docState'

interface Props {
  prog: GraphProgram
  /** 全部操作以纯函数变换 prog 后回调；返回 false 表示失败（非法名/撞名），调用方还原输入 */
  onSet: (name: string, value: Json) => boolean
  onRename: (oldName: string, newName: string) => boolean
  onRemove: (name: string) => boolean
}

export function VariablesPanel({ prog, onSet, onRename, onRemove }: Props) {
  const vars = prog.variables ?? {}
  // __ 前缀 = 系统变量（如行门控用的 __row）：运行时存在但不向作者开放改名/删除（评审 P2-6）
  const entries = Object.entries(vars).filter(([name]) => !name.startsWith('__'))
  const [newName, setNewName] = useState('')

  const add = (): void => {
    const base = newName.trim() || `var${entries.length + 1}`
    let name = base
    let i = 2
    while (name in vars) {
      name = `${base}${i}`
      i++
    }
    onSet(name, 0)
    setNewName('')
  }

  return (
    <div className="gvars">
      <div className="glib-title">变量（{entries.length}）</div>
      {entries.length === 0 && <div className="glib-empty muted">暂无变量</div>}
      {entries.map(([name, value]) => (
        <div key={name} className="gvar-row">
          <input
            className="gvar-name"
            defaultValue={name}
            title="改名（失焦保存；assign 节点同步更新，表达式旧引用由 lint 提示）"
            onBlur={(e) => {
              const next = e.target.value.trim()
              if (next === name || next === '') {
                e.target.value = name
                return
              }
              if (!onRename(name, next)) e.target.value = name // 非法/撞名：还原
            }}
          />
          <input
            className="gvar-value"
            defaultValue={JSON.stringify(value)}
            title="初值（true/false→布尔、数字→数值；[/{ 开头按 JSON 解析；失焦保存）"
            onBlur={(e) => {
              // 未变更失焦不回写（否则数组初值会被启发式解析静默毁成字符串）
              if (e.target.value === JSON.stringify(value)) return
              const text = e.target.value.trim()
              if (text.startsWith('[') || text.startsWith('{')) {
                try {
                  onSet(name, JSON.parse(text) as Json)
                  return
                } catch {
                  e.target.value = JSON.stringify(value)
                  return
                }
              }
              onSet(name, parseScalarInput(text))
            }}
          />
          <button
            type="button"
            className="ginsp-argdel"
            title={`删除 ${name}`}
            onClick={() => {
              if (!onRemove(name)) return
            }}
          >
            ×
          </button>
        </div>
      ))}
      <div className="gvar-add">
        <input
          placeholder="新变量名…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <button type="button" onClick={add}>
          + 添加
        </button>
      </div>
    </div>
  )
}
