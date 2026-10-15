/**
 * 服务端关卡信封校验（docs/31 §6.5 定稿）：用 @cfworker/json-schema 加载与前端
 * 完全相同的 schemas/v1/level.json。不直接复用 src/library/validate.ts 的原因：
 * Ajv 通过 new Function 动态生成校验器，workerd 禁止动态代码生成（EvalError）；
 * cfworker 版是闭包式校验器、专为 Workers 设计。跨文件 $ref（common/logic 等）
 * 以完整 $id 注册解析（Node 冒烟已验证：真实样例通过、篡改被拒）。
 *
 * Validator 在模块顶层预编译——属 workerd startup 预算（400ms），不占请求 10ms CPU；
 * 请求期 validate() 为纯闭包执行（<5ms）。
 */
import { Validator, type Schema } from '@cfworker/json-schema'
import commonRaw from '../schemas/v1/common.json'
import graphLogicRaw from '../schemas/v1/graph-logic.json'
import instrumentRaw from '../schemas/v1/instrument.json'
import levelRaw from '../schemas/v1/level.json'
import logicRaw from '../schemas/v1/logic.json'
import seriesRaw from '../schemas/v1/series.json'
import topicRaw from '../schemas/v1/topic.json'

const validator = new Validator(levelRaw as unknown as Schema)
for (const schema of [commonRaw, logicRaw, graphLogicRaw, seriesRaw, topicRaw, instrumentRaw]) {
  validator.addSchema(schema as unknown as Schema, (schema as { $id?: string }).$id)
}

/** 文件夹上传（docs/39 H2）按 kind 分发的校验器：系列/专题与关卡同一组 $ref 注册 */
const seriesValidator = new Validator(seriesRaw as unknown as Schema)
const topicValidator = new Validator(topicRaw as unknown as Schema)
for (const v of [seriesValidator, topicValidator]) {
  for (const schema of [commonRaw, levelRaw]) {
    v.addSchema(schema as unknown as Schema, (schema as { $id?: string }).$id)
  }
}

const VALIDATORS: Record<string, Validator> = {
  level: validator,
  series: seriesValidator,
  topic: topicValidator,
}

function shapeErrors(result: { valid: boolean; errors: { instanceLocation: string; error: string }[] }): { ok: boolean; errors: string[] } {
  if (result.valid) return { ok: true, errors: [] }
  return {
    ok: false,
    errors: result.errors.slice(0, 5).map((e) => `${e.instanceLocation || '/'} ${e.error}`),
  }
}

export function validateLevelDoc(doc: unknown): { ok: boolean; errors: string[] } {
  return shapeErrors(validator.validate(doc))
}

/** 按信封 kind 分发校验（series/topic/level 之外的 kind 一律拒绝） */
export function validateDocByKind(kind: string, doc: unknown): { ok: boolean; errors: string[] } {
  const v = VALIDATORS[kind]
  if (v === undefined) return { ok: false, errors: [`未知的文档 kind: ${kind}`] }
  return shapeErrors(v.validate(doc))
}
