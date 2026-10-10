/**
 * 服务端随机 ID：Crockford Base32 26 位 + 域前缀。形态对齐资源库 res_* 惯例，
 * 但服务端自产实体用独立前缀（usr_/ses_…）避免与资源 id 混淆。
 * 项目铁律「id 一律程序化生成」：用 crypto.getRandomValues，绝不用 Math.random。
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(26)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i] % 32]
  return `${prefix}_${out}`
}

export function newUserId(): string {
  return randomId('usr')
}
