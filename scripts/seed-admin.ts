/**
 * 管理员种子脚本（docs/31 §6.7）：本地计算 PBKDF2 哈希（直接复用 worker/password.ts，
 * 与服务端同一实现），输出可粘贴执行的 INSERT——脚本不经网络、不落盘任何凭据。
 *
 * 用法：node scripts/seed-admin.ts   （Node ≥24 原生运行 TS；导入链全部为可擦除语法）
 * 然后：npx wrangler d1 execute musicpractise-db --remote --command "<输出整句>"
 */
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { newUserId } from '../worker/id.ts'
import { hashPassword, PBKDF2_ITERATIONS } from '../worker/password.ts'
import { checkNickname, checkPassword } from '../worker/validate.ts'

/** 纯函数导出供单测：生成管理员 INSERT（单引号转义防注入/防语法破裂） */
export function buildAdminInsert(input: { id: string; nickname: string; pwHash: string; now: number }): string {
  const esc = (s: string): string => s.replace(/'/g, "''")
  return (
    'INSERT INTO users (id, nickname, pw_hash, role, status, created_at, updated_at) VALUES (' +
    `'${esc(input.id)}', '${esc(input.nickname)}', '${esc(input.pwHash)}', 'admin', 'active', ${input.now}, ${input.now})`
  )
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log(`MusicPractise 管理员种子（PBKDF2-SHA256 × ${PBKDF2_ITERATIONS}，本地计算，不发送任何网络请求）`)
  const rawNickname = await rl.question('管理员昵称（2–24 字符）: ')
  const rawPassword = await rl.question('管理员密码（≥8 位，输入会回显）: ')
  rl.close()

  const nickname = checkNickname(rawNickname)
  if (!nickname.ok) {
    console.error(`昵称不合法：${nickname.message}`)
    process.exit(1)
  }
  const password = checkPassword(rawPassword)
  if (!password.ok) {
    console.error(`密码不合法：${password.message}`)
    process.exit(1)
  }

  const id = newUserId()
  const pwHash = await hashPassword(password.value)
  const now = Date.now()
  console.log('\n在仓库根目录执行：\n')
  console.log(`npx wrangler d1 execute musicpractise-db --remote --command "${buildAdminInsert({ id, nickname: nickname.value, pwHash, now })}"`)
}

// 仅直接运行本文件时进入交互；被测试/其他模块导入时无副作用
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
