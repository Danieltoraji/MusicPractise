# 34 · 编辑器 AI 工具全量报 CSP EvalError —— 根因与修复

日期：2026-10-12 · 状态：已修复

## 现象

部署站点上，编辑器 AI 助手所有会产生副作用的工具调用（`set_variable` / `write_script` / `lint` / `run_level`）都返回同一条宿主级错误：

> Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self'

本地 `npm run dev`（Vite，无 CSP 头）与全量测试均无法复现——只在生产形态出现。

## 根因

1. **CSP 来源**：批次 B5 安全加固后，Worker 对全部响应（含 SPA 静态资产回落）注入严格 CSP（`worker/http.ts`），纯静态资产由 `public/_headers` 注入同一组头——`script-src 'self'`，无 `unsafe-eval`，且 `worker/http.test.ts` 有断言保护，**不应放松**。
2. **eval 的真身不是业务代码**：`src/` 中没有任何 `eval`/`new Function`（表达式引擎是手写词法/语法解释器）。动态求值来自 **Ajv**——`src/library/validate.ts` 用 `ajv/dist/2020` 编译 JSON Schema，Ajv 编译期用 `new Function` 生成校验器代码，被 CSP 直接拦下抛 `EvalError`。
3. **爆炸半径为何是"所有副作用工具"**：四个工具全部汇入同一条校验管线：
   - `lint` → `loadLevelDoc`（`src/ai/tools.ts`）
   - `set_variable` / `write_script` / 其余写工具 → `applyAndCheck` → `loadLevelDoc`（`src/ai/tools-write.ts`）
   - `run_level` → `runHarness` 预检 → `loadLevelDoc`（`src/ai/runHarness.ts`）

   首次编译 Schema 即抛错，agent 循环把异常格式化为「工具执行出错：…」回填（`src/ai/agent.ts`），于是每个工具都带回同一条 CSP 文案。连带受害的还有资源库导入（`src/library/io.ts`）、游玩页与编辑器装载（`LevelPage`/`EditorPage` 均走 `loadLevelDoc`）。
4. **项目早有答案**：服务端 `worker/schema.ts` 因为 workerd 同样禁动态代码生成，早已改用 `@cfworker/json-schema`（闭包式校验器，无 eval），头注释写明了这一选型原因——但前端管线漏改。

## 修复

- `src/library/validate.ts`：Ajv → `@cfworker/json-schema` `Validator`（与 `worker/schema.ts` 同款）。各 kind 惰性建一个校验器，其余 schema 以完整 `$id` 注册供跨文件 `$ref` 解析；注意**根 schema 已随构造器注册，重复 `addSchema` 同一 `$id` 会被 cfworker 拒绝**（Duplicate schema URI）。错误映射为 `${instanceLocation} ${error}`。
- 对外 API 形状不变：`validateEnvelope` / `loadLevelDoc` / `SCHEMA_BASE` / `KNOWN_KINDS` / `SCHEMA_RAW`。仅移除 `buildAjv` 导出。
- `src/schemas.test.ts`：就地自建 Ajv2020 实例（测试在 Node，无 CSP）继续交叉验证同一组 schema——双校验器一致才算过。
- `package.json`：`ajv` 移入 devDependencies（仅测试用）；运行时主包不再含 Ajv，顺带瘦身。
- CSP 保持 `script-src 'self'` 不变，安全姿态不回退。

## 验证

- 全量测试 679/679 通过（含 `validate.test.ts`、`schemas.test.ts`、AI 工具与 runHarness 全链路单测）；`tsc --noEmit` 干净；`vite build` 成功。
- 浏览器冒烟（生产等价形态）：本地静态服务器伺服 `dist/` 并注入与生产一字不差的 CSP 头。页面内联 `<script>` 探针被拦（`securitypolicyviolation: script-src-elem`，证明 CSP 对页面代码真实生效）的前提下，打开 `#/edit/<id>` 编辑器完整渲染（画布/组件/AI 面板），`loadLevelDoc` 全链路无任何 eval 类违规——修复前此处即炸。

## 备注

- Playwright `evaluate` 走 CDP 通道豁免页面 CSP，不能用它做"eval 被拦"的对照组；要用页面自身的内联脚本探针 + `securitypolicyviolation` 事件。
- 今后前端凡引入会动态生成代码的库（Ajv、部分模板引擎、某些 ORM query builder）须先过 CSP 审查：部署站点运行 `script-src 'self'`，`new Function` 一律不可用。
- **补充（2026-10-23，docs/42 G6 / docs/43）**：本文已验证「内联脚本会被生产 CSP 拦截」，但 docs/41 R10 仍用 `index.html` 内联 `<script>` 做首帧皮肤预置（dev 无 CSP 所以“实测通过”）——R13 已改为外置 `public/skin-boot.js`（`%BASE_URL%` 引用、同白名单、CSP 不变），并新增 `src/test/bootstrapSecurity.test.ts` 静态互锁。今后**禁止在 `index.html` 写内联脚本**（含第三方片段），引导脚本一律放 `public/` 外置。
