# 音乐练习 · UGC 平台

Web 应用：前端 SPA（Vite + React + TypeScript strict）+ Cloudflare Workers 单通道后端 + D1 数据库（静态资产与 `/api` 同源）。
内容层级为 **系列 → 专题 → 关卡 → 题目**，全部层级支持 UGC：关卡由组件实例拼装，逻辑用控制流图 GraphProgram v2 描述，
创作 → 游玩 → 进度全链路在浏览器完成，并可经审核进入全站共享的关卡库。

## 运行

```bash
npm install
npm run dev              # http://localhost:5173（纯前端；/api 走 vite 代理 → wrangler dev）
npm run db:migrate:local # D1 迁移应用到本地模拟库（本地全栈流程一次）
npm run dev:worker       # wrangler dev 全栈验证（先 npm run build 产出 dist/）
npm test                 # Vitest：引擎/运行时/编辑器/AI/资源库/云盘/关卡库 + worker API（现行基线 972 项全绿 / 105 文件）
npm run build            # tsc strict + Vite 生产构建
```

## 功能一览

**游玩**：`#/` 首页（系列与独立关卡）· `#/series/:id` 系列详情（专题→关卡+进度）· `#/level/:id` 运行关卡。
练习进度（最高分/通过/次数）存 IndexedDB，只升不降；登录后自动云端同步（多端单调合并，离线/未登录完全不受影响）。
内置 10 个示例关卡与入门系列自动入库；支持导入 `.json` 关卡与 `.zip` 系列包、导出自包含 zip（同 id 同版本跳过、异版本覆盖）。

**创作**：`#/edit/:id` 关卡编辑器，五 Tab = 画布 / 节点图 / 伪代码 / 数据表 / JSON（同一逻辑程序的三个投影）；
内置 AI 助手（ask / plan / agent 三模式，写操作全走「生成→校验→应用→自纠」管线 + 检查点回滚）与调试模式（断点/单步/变量快照/AI 试玩人机共享）。
`#/graph/:id` 为只读逻辑图谱。资源库 `#/library` 提供文件夹树 / 文件管理器 / 就地编辑（保存自动另存副本）。

**共享**：登录用户（⚙ 设置「账户」区注册/登录）：
- `#/cloud` 我的云盘：关卡与整个系列文件夹跨设备存取（槽位合并口径 ≤10 个关卡：直存关卡数 + 文件夹内含关卡数）；
- 通关记录自动云端同步；
- 关卡/系列可「申请公开」（快照制，更新需重新审核），经管理员审核进入 `#/hub` 关卡库（公共 / 精选 / 官方 / 群组），可下载他人发布的作品；
- 群组关卡库：暗号（全局唯一）+ 可选密码建群/加入，群主与审核员审核群内投稿（群库 ≤100 关）。

**其他**：`#/skins` 皮肤中心（多套主题，剧场/编辑器明暗裁决见 docs/37/38） · `#/docs` 站内文档与[更新日志](https://musicpractise.danieltoraji.workers.dev/#/docs/changelog) · `#/tuner` 校音器（麦克风→音分） · `#/rhythm` 节奏判定 · `#/admin` 管理后台（用户/云盘/审核队列/官方库/群组/审计）。

## 部署

站点唯一入口：**https://musicpractise.danieltoraji.workers.dev/**（Cloudflare Workers：静态资产与后端 `/api` 同源服务，HTTPS 由边缘自动签发）。

已裁决**放弃 GitHub Pages 通道**（2026-10，[docs/31](docs/31-后端与账户体系设计.md) §3）：Pages CI job 已随批次 B1 移除，
原 Pages URL（`danieltoraji.github.io/MusicPractise/`）停更，可在仓库 Settings → Pages 关闭。

后端（账户 / 云盘 / 通关记录 / 管理后台，docs/31 批次 B1 起）一次性前置（2026-10 已完成）：

1. GitHub 仓库两个 Secret（值来自 Cloudflare 面板）：`CLOUDFLARE_API_TOKEN`（自定义 Token，权限 Account → Workers Scripts: Edit + D1: Edit）与 `CLOUDFLARE_ACCOUNT_ID`；
2. D1 数据库 `musicpractise-db` 已创建（面板 Storage & Databases → D1），`database_id` 已填入 `wrangler.jsonc`；
3. 建表迁移由 CI 在每次部署前自动执行（`d1 migrations apply musicpractise-db --remote`）。

创建管理员（一次性，脚本本地计算哈希、不经网络；**昵称建议 ASCII**）：

```powershell
node scripts/seed-admin.ts --nickname=admin --password=<你的密码> --out=seed-admin.sql
npx wrangler d1 execute musicpractise-db --remote --file=seed-admin.sql
Remove-Item seed-admin.sql   # 内含密码哈希，执行后删除
```

（`--out` 文件方式绕开 PowerShell/Git Bash 的引号转义差异，直接 `--command` 粘贴长 SQL 会踩坑。）

管理员登录后经设置页「管理后台 →」进入 `#/admin`（用户管理/云盘关卡管理/关卡库审核与官方库/群组管理/审计日志）。

## 运维

- **安全响应头**：静态资产经 `public/_headers`、`/api` 经 worker 注入（nosniff/X-Frame-Options: DENY/Referrer-Policy/Permissions-Policy/CSP）。
- **平台防护**：Cloudflare 面板 Security → Bots 开启 Bot Fight Mode；WAF 自定义规则可选限制 `/api/admin/*`；DDoS 吸收默认开启。
- **备份**：D1 Time Travel 默认开启（30 天回溯 `wrangler d1 time-travel restore`）；定期冷备 `npx wrangler d1 export musicpractise-db --remote --output=backup.sql`。
- 详细设计（选型/数据模型/安全设计/批次记录）见 [docs/31](docs/31-后端与账户体系设计.md)。

## 文档

设计/评审/落地记录按编号归档 `docs/`，站内可在 `#/docs` 阅读；工程约定见 [AGENTS.md](AGENTS.md)。

| 文档 | 内容 |
|---|---|
| [docs/01-预研报告.md](docs/01-预研报告.md) | 技术选型对比、架构、风险清单、POC 验证记录 |
| [docs/02-数据结构设计.md](docs/02-数据结构设计.md) | 数据结构规范（人读版）：资源信封、组件契约、逻辑程序、题目模型 |
| [docs/27-数据表全可视化2_0.md](docs/27-数据表全可视化2_0.md) | 编辑器数据表 2.0：一行一题、全类型弹窗编辑 |
| [docs/31-后端与账户体系设计.md](docs/31-后端与账户体系设计.md) | 后端建设：Workers 单通道 + D1 选型、数据模型、API 契约、安全设计与批次 B1–B5 记录 |
| [docs/36-UI全量重设计.md](docs/36-UI全量重设计.md) | 设计令牌体系与全站 UI 重设计（含皮肤系统） |
| [docs/37-运行时UI改造.md](docs/37-运行时UI改造.md) | 游玩页剧场化改造与主题裁决 |
| [docs/38-编辑器界面改造.md](docs/38-编辑器界面改造.md) | 编辑器界面改造与移动端口径 |
| [docs/39-云盘共享与关卡库迭代.md](docs/39-云盘共享与关卡库迭代.md) | 云盘文件夹化、公共/精选/官方/群组关卡库、审核流（H1–H6 已落地） |
| [docs/40-编辑器前端开发坑位与风险清单.md](docs/40-编辑器前端开发坑位与风险清单.md) | 编辑器前端全量审计：30 P1 / 66 P2 / 20 观察，逐条 文件:行 证据与修复路线 |
| [docs/41-编辑器修复批次落地记录.md](docs/41-编辑器修复批次落地记录.md) | docs/40 修复执行：批次 R1–R12 总表、裁决与逐批回填（commit/用例/实测） |

## 目录

```
schemas/v1/        JSON Schema（common/logic/level/series/topic/instrument）
src/engine/        逻辑引擎：沙箱表达式求值器、GraphProgram v2 IR + lint、异步图执行器、伪代码↔IR 往返、迁移器、节奏判定
src/runtime/       关卡运行器（无头可驱动）、共享舞台 LevelStage、音频调度（smplr 钢琴 + AudioContext 时钟）、组件状态仓库
src/components/    组件定义（纯函数 reducer：events/commands/state 契约）与视图（VexFlow 谱面等）
src/editor/        关卡编辑器（五 Tab）、节点图工作台、数据表、AI 助手（src/ai/）
src/ai/            编辑器内 AI：providers/client/agent、写工具七件套、运行闭环 runHarness、检查点
src/library/       Dexie 资源库：db/导入导出 io/文件夹树 browse/校验 validate/文件管理 manage
src/cloud/         云盘 API 客户端与 #/cloud 我的云盘页
src/hub/           #/hub 关卡库（公共/精选/官方/群组）
src/skin/          皮肤系统（#/skins）
src/admin/         管理后台页（#/admin）
src/sample/        10 个内置示例关卡 + 入门系列 JSON
src/pages/         首页 / 关卡页 / 校音 demo / 节奏 demo
worker/            单通道 API：路由/会话/限流/管理员/密码哈希/安全头 + D1 migrations + JSON Schema
```

## 核心思想

**关卡 = 组件实例 + 逻辑程序 + 题目数据，全部在 JSON 里。**

- 组件只暴露统一契约（events / commands / state），数据应用收口为 `call` 三命令 `setText` / `setOptions` / `setMusic`；
- 逻辑是控制流图 **GraphProgram v2**（wait/分支/循环），采用「单一 IR 三视图」：伪代码、节点图、JSON 是同一程序的投影，先设计代码再设计节点图；
- 表达式在沙箱求值（作用域根仅 `$q.` / `$event.` / `$v.`，函数白名单 + 步数预算，拒绝赋值/循环/原型逃逸）；
- 题目是纯数据，经 `$q.xxx` 绑定随题注入——一个关卡模板出任意多题，判定逻辑零硬编码；
- AI 辅助创作与人工编辑走同一条「生成 → `loadLevelDoc` 校验 → 应用 → 被拒不回喂自纠」管线，附检查点回滚。
