/**
 * 资源 id 生成：res_ + 26 位 Crockford Base32（不含 I/L/O/U），满足 schema 的 ULID 形态约束。
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newResourceId(): string {
  let out = ''
  for (let i = 0; i < 26; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return `res_${out}`
}
