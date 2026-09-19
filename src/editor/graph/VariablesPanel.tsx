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
  /** 全部操作以纯函数变换 prog 后回调（容器统一走 apply 错误条） */
  onSet: (name: string, value: Json) => void
  onRename: (oldName: string, newName: string) => void
  onRemove: (name: string) => void
}

export function VariablesPanel({ prog, onSet, onRename, onRemove }: Props) {
  const vars = prog.variables ?? {}
  const entries = Object.entries(vars)
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
              if (next && next !== name) {
                try {
                  onRename(name, next)
                } catch {
                  // 非法/撞名：还原输入框
                  e.target.value = name
                }
              } else {
                e.target.value = name
              }
            }}
          />
          <input
            className="gvar-value"
            defaultValue={JSON.stringify(value)}
            title="初值（true/false→布尔、数字→数值，其余为字符串；失焦保存）"
            onBlur={(e) => {
              const parsed = parseScalarInput(e.target.value)
              onSet(name, parsed)
            }}
          />
          <button type="button" className="ginsp-argdel" title={`删除 ${name}`} onClick={() => onRemove(name)}>
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
