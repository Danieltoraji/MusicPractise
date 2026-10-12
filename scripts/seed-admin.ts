/**
 * 管理员种子脚本（docs/31 §6.7）：本地计算 PBKDF2 哈希（直接复用 worker/password.ts，
 * 与服务端同一实现），输出可粘贴执行的 INSERT——脚本不经网络、不落盘任何凭据。
 *
 * 用法一（非交互，推荐自动化/管道场景）：
 *   node scripts/seed-admin.ts --nickname=站长 --password=admin-pass-123
 * 用法二（交互，TTY 下自动启用）：node scripts/seed-admin.ts
 * 然后：npx wrangler d1 execute musicpractise-db --remote --command "<输出整句>"
 *
 * 注意：Node ≥24 原生运行 TS；导入链全部为可擦除语法。
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

async function readInteractive(): Promise<{ nickname: string; password: string }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const rawNickname = await rl.question('管理员昵称（2–24 字符）: ')
    const rawPassword = await rl.question('管理员密码（≥8 位，输入会回显）: ')
    return { nickname: rawNickname, password: rawPassword }
  } finally {
    // readline 句柄必须存活到答案读取完成；关闭时机交由 finally（进程收尾）
    rl.close()
  }
}

async function main(): Promise<void> {
  const argNickname = process.argv.find((a) => a.startsWith('--nickname='))
  const argPassword = process.argv.find((a) => a.startsWith('--password='))
  let raw: { nickname: string; password: string }
  if (argNickname !== undefined && argPassword !== undefined) {
    raw = { nickname: argNickname.slice('--nickname='.length), password: argPassword.slice('--password='.length) }
  } else if (process.stdin.isTTY) {
    console.log(`MusicPractise 管理员种子（PBKDF2-SHA256 × ${PBKDF2_ITERATIONS}，本地计算，不发送任何网络请求）`)
    raw = await readInteractive()
  } else {
    console.error('非交互环境：请使用参数 --nickname=<昵称> --password=<密码>（或在本机终端直接运行进入交互模式）')
    process.exitCode = 1
    return
  }

  const nickname = checkNickname(raw.nickname)
  if (!nickname.ok) {
    console.error(`昵称不合法：${nickname.message}`)
    process.exitCode = 1
    return
  }
  const password = checkPassword(raw.password)
  if (!password.ok) {
    console.error(`密码不合法：${password.message}`)
    process.exitCode = 1
    return
  }

  const id = newUserId()
  const pwHash = await hashPassword(password.value)
  const now = Date.now()
  console.log('\n在仓库根目录执行：\n')
  console.log(`npx wrangler d1 execute musicpractise-db --remote --command "${buildAdminInsert({ id, nickname: nickname.value, pwHash, now })}"`)
}

// 仅直接运行本文件时执行；被测试/其他模块导入时无副作用
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
