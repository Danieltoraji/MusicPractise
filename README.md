# 音乐练习 · UGC 平台（预研 + POC）

Web 应用：前端 SPA + Cloudflare Workers 后端（静态资产与 `/api` 同源，D1 数据库）。
内容层级为 **系列 → 专题 → 关卡 → 题目**，全部层级支持 UGC。
关卡由组件拼装（五线谱/发声/按钮/文本/选择器…），组件间关系与题目判据由统一接口上的
ECA 规则引擎（"简易代码"）描述；节点图编辑器是后续阶段对同一运行时的可视化前端。

## 运行

```bash
npm install
npm run dev              # http://localhost:5173（纯前端；/api 走 vite 代理 → wrangler dev）
npm run db:migrate:local # D1 迁移应用到本地模拟库（本地全栈流程一次）
npm run dev:worker       # wrangler dev 全栈验证（先 npm run build 产出 dist/）
npm test                 # Vitest：引擎单测 + JSON Schema 校验 + 资源库/导入导出 + worker API
npm run build            # tsc strict + Vite 生产构建
```

- `#/` 首页（系列与独立关卡） · `#/series/:id` 系列详情（专题→关卡+进度） · `#/library` 资源库（导入/导出/删除/试玩） · `#/level/:id` 运行关卡 · `#/graph/:id` 逻辑图谱（只读节点图）
- 内置五关 + 听音点击·测试 + 入门系列自动入库；支持导入 `.json` 关卡与 `.zip` 系列包、导出自包含 zip；编辑器「新建关卡 / 编辑副本」
- 练习进度（最高分/通过/次数）存 IndexedDB，首页与系列页展示
- 登录用户（⚙ 设置「账户」区注册/登录）：云盘上传 ≤10 个关卡跨设备下载（资源库行「☁ 上传」/设置页「云盘」区），通关记录自动云端同步（多端单调合并，离线/未登录完全不受影响）
- `#/tuner` 校音器（麦克风→音分） · `#/rhythm` 节奏判定

## 部署

站点唯一入口：**https://musicpractise.danieltoraji.workers.dev/**（Cloudflare Workers：静态资产与后端 `/api` 同源服务，HTTPS 由边缘自动签发）。

已裁决**放弃 GitHub Pages 通道**（2026-10，[docs/31](docs/31-后端与账户体系设计.md) §3）：Pages CI job 已随批次 B1 移除，
原 Pages URL（`danieltoraji.github.io/MusicPractise/`）停更，可在仓库 Settings → Pages 关闭。

后端（账户 / 云盘 / 通关记录 / 管理后台，docs/31 批次 B1 起）一次性前置（2026-10 已完成）：

1. GitHub 仓库两个 Secret（值来自 Cloudflare 面板）：`CLOUDFLARE_API_TOKEN`（自定义 Token，权限 Account → Workers Scripts: Edit + D1: Edit）与 `CLOUDFLARE_ACCOUNT_ID`；
2. D1 数据库 `musicpractise-db` 已创建（面板 Storage & Databases → D1），`database_id` 已填入 `wrangler.jsonc`；
3. 建表迁移由 CI 在每次部署前自动执行（`d1 migrations apply musicpractise-db --remote`）。

创建管理员（一次性，脚本本地计算哈希、不经网络）：

```bash
node scripts/seed-admin.ts   # 按提示输入昵称密码，输出 INSERT 语句
npx wrangler d1 execute musicpractise-db --remote --command "<输出整句>"
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/01-预研报告.md](docs/01-预研报告.md) | 技术选型对比、架构、风险清单、POC 验证记录 |
| [docs/02-数据结构设计.md](docs/02-数据结构设计.md) | 数据结构规范（人读版）：资源信封、组件契约、逻辑程序、题目模型 |
| [docs/31-后端与账户体系设计.md](docs/31-后端与账户体系设计.md) | 后端扩充规划：Workers 单通道 + D1 选型、负载测算、数据模型、API 契约、安全设计与批次 B1–B5 路线 |

## 目录

```
schemas/v1/        JSON Schema（common/logic/level/series/topic/instrument），Ajv 可校验
src/engine/        逻辑引擎：安全表达式求值器、ECA 规则引擎、节奏判定纯函数（含单测）
src/runtime/       关卡运行器、组件状态仓库、音频引擎（smplr 钢琴 + AudioContext 时钟）
src/components/    组件定义（纯函数 reducer）与视图（VexFlow 谱面等）
src/sample/        两份示例关卡 JSON —— 运行器实际装载的就是它们
src/pages/         首页 / 关卡页 / 校音 demo / 节奏 demo
```

## 核心思想

**关卡 = 组件实例 + 逻辑规则 + 题目数据，全部在 JSON 里。**
组件只暴露统一契约（events / commands / state / bindings）；规则是
「事件 → 条件表达式 → 动作」；题目是纯数据，经 `$q.xxx` 绑定随题注入——
一个关卡模板出任意多题，判定逻辑零硬编码。
