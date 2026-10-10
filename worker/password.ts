/**
 * 密码哈希（docs/31 §6.1）：PBKDF2-SHA256（WebCrypto，workerd 与 Node 同源实现，
 * 种子脚本 scripts/seed-admin.ts 直接复用本模块）。存储格式自描述：
 *   pbkdf2$<iterations>$<saltB64>$<hashB64>
 * 迭代数随哈希存储，未来升级轮数/算法可并存验证、无需迁移。
 *
 * PBKDF2_ITERATIONS 是单点常量：B1 在 wrangler dev 实测定档（免费版单请求 10ms CPU
 * 红线内取最大档，参考 workerd#1346 对 PBKDF2 迭代的上限讨论）；超限降档只需改这里。
 */
export const PBKDF2_ITERATIONS = 100_000
const PBKDF2_BITS = 256

const encoder = new TextEncoder()

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveBits(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    PBKDF2_BITS,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(bits)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations < 1) return false
  try {
    const bits = await deriveBits(password, fromB64(parts[2]), iterations)
    return timingSafeEqual(bits, fromB64(parts[3]))
  } catch {
    return false
  }
}

/** 登录防枚举：对不存在的用户执行一次等量派生，拉平与真实校验的响应耗时（docs/31 §6.1） */
export async function dummyVerify(): Promise<void> {
  await deriveBits('dummy-password-for-timing-equalization', crypto.getRandomValues(new Uint8Array(16)), PBKDF2_ITERATIONS)
}

/** 恒时比较：逐字节异或累计差异，长度不同直接不等（长度本身不算秘密） */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
