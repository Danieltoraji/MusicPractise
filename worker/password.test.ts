import { describe, expect, it } from 'vitest'
import { dummyVerify, hashPassword, PBKDF2_ITERATIONS, verifyPassword } from './password'

describe('密码哈希（PBKDF2-SHA256，WebCrypto 真跑）', () => {
  it('hash→verify 往返：正确密码通过、错误密码拒绝', async () => {
    const stored = await hashPassword('正确密码-12345678')
    expect(await verifyPassword('正确密码-12345678', stored)).toBe(true)
    expect(await verifyPassword('错误密码-87654321', stored)).toBe(false)
  })

  it('存储格式自描述：pbkdf2$迭代数$盐$哈希，随机盐使同密码两次哈希不同', async () => {
    const a = await hashPassword('same-password-123')
    const b = await hashPassword('same-password-123')
    expect(a).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(a.split('$')[1]).toBe(String(PBKDF2_ITERATIONS))
    expect(a).not.toBe(b)
    expect(await verifyPassword('same-password-123', a)).toBe(true)
    expect(await verifyPassword('same-password-123', b)).toBe(true)
  })

  it('存储串损坏返回 false 而非抛错（段数不足/方案不符/坏 base64）', async () => {
    expect(await verifyPassword('x-12345678', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x-12345678', 'bcrypt$100$aa$bb')).toBe(false)
    expect(await verifyPassword('x-12345678', 'pbkdf2$abc$!!$!!')).toBe(false)
    expect(await verifyPassword('x-12345678', 'pbkdf2$100000$%%%',)).toBe(false)
  })

  it('dummyVerify 不抛错（防枚举等耗时路径可执行）', async () => {
    await expect(dummyVerify()).resolves.toBeUndefined()
  })
})
