/**
 * 原型污染防护（docs/31 §6.5）：上传载荷递归 walk，拒绝 __proto__/constructor/prototype
 * 键——schema 层（additionalProperties 宽松的 meta 等位置）拦不住这类键。深度上限防
 * 栈溢出；512KB 体积上限内全量 walk 在请求 CPU 预算内。
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_DEPTH = 20

/** 命中返回危险键名，否则 null */
export function findProtoViolation(value: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findProtoViolation(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) return key
      const hit = findProtoViolation(child, depth + 1)
      if (hit) return hit
    }
  }
  return null
}
