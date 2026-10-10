import { describe, expect, it } from 'vitest'
import { D1Fake } from './testhelpers/d1fake'
import { hashPassword } from './password'
import { findUserById, findUserByNickname, insertUser, isUniqueViolation, updateUserNickname, updateUserPassword } from './users'
import type { UserRow } from './types'

const NOW = 1_700_000_000_000
const ID = 'usr_TEST0000000000000000000001'

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: ID,
    nickname: 'Alice',
    pw_hash: 'pbkdf2$100000$aaaa$bbbb',
    role: 'user',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

/** 吞掉预期中的插入错误，返回捕获值供断言 */
function insertError(db: D1Fake, row: UserRow): Promise<unknown> {
  return insertUser(db, row).then(
    () => null,
    (err: unknown) => err,
  )
}

describe('users DAO（D1 fake）', () => {
  it('insert → findById / findByNickname（大小写不敏感）', async () => {
    const db = new D1Fake()
    const pwHash = await hashPassword('password-123456')
    await insertUser(db, makeUser({ pw_hash: pwHash }))
    const row = await findUserById(db, ID)
    expect(row).toMatchObject({ nickname: 'Alice', pw_hash: pwHash })
    expect(await findUserByNickname(db, 'Alice')).not.toBeNull()
    expect(await findUserByNickname(db, 'alice')).not.toBeNull()
    expect(await findUserByNickname(db, 'ALICE')).not.toBeNull()
    expect(await findUserByNickname(db, '不存在')).toBeNull()
    expect(await findUserById(db, 'usr_NOPE')).toBeNull()
  })

  it('同名（含大小写变体）插入抛 UNIQUE，isUniqueViolation 识别', async () => {
    const db = new D1Fake()
    await insertUser(db, makeUser())
    expect(isUniqueViolation(await insertError(db, makeUser({ id: 'usr_TEST0000000000000000000002' })))).toBe(true)
    expect(isUniqueViolation(await insertError(db, makeUser({ id: 'usr_TEST0000000000000000000003', nickname: 'alice' })))).toBe(true)
    expect(isUniqueViolation(await insertError(db, makeUser({ id: 'usr_TEST0000000000000000000004', nickname: 'ALICE' })))).toBe(true)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation(new Error('其他错误'))).toBe(false)
  })

  it('update 昵称/密码落库', async () => {
    const db = new D1Fake()
    await insertUser(db, makeUser())
    await updateUserNickname(db, ID, '新名字', NOW + 1)
    await updateUserPassword(db, ID, 'pbkdf2$1$x$y', NOW + 2)
    expect(await findUserById(db, ID)).toMatchObject({ nickname: '新名字', pw_hash: 'pbkdf2$1$x$y', updated_at: NOW + 2 })
  })
})
