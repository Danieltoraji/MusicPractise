import { describe, expect, it } from 'vitest'
import { buildAdminInsert } from './seed-admin'
import { checkNickname, checkPassword } from '../worker/validate'

describe('seed-admin（管理员种子脚本）', () => {
  it('buildAdminInsert：完整列 + admin 角色；单引号转义', () => {
    const sql = buildAdminInsert({ id: 'usr_X', nickname: "O'Brien", pwHash: "pbkdf2$1$aa'$bb", now: 123 })
    expect(sql).toContain("INSERT INTO users (id, nickname, pw_hash, role, status, created_at, updated_at) VALUES ('usr_X', 'O''Brien', 'pbkdf2$1$aa''$bb', 'admin', 'active', 123, 123)")
  })

  it('校验函数与 worker 共用：昵称/密码规则一致', () => {
    expect(checkNickname('小明')).toEqual({ ok: true, value: '小明' })
    expect(checkNickname(' 小明 ')).toEqual({ ok: true, value: '小明' })
    expect(checkNickname('a').ok).toBe(false)
    expect(checkNickname(' 小明'.slice(0, 2)).ok).toBe(false)
    expect(checkNickname('a'.repeat(25)).ok).toBe(false)
    expect(checkNickname('bad\u0000name').ok).toBe(false)
    expect(checkPassword('12345678').ok).toBe(true)
    expect(checkPassword('1234567').ok).toBe(false)
    expect(checkPassword('x'.repeat(129)).ok).toBe(false)
  })
})
