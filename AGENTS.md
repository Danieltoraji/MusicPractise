# AGENTS.md — MusicPractise（音乐练习 UGC 平台）

> 本文件由 Hindsight 记忆库蒸馏而来（该服务已停用），深度历史资料见 `F:\hindsight\export\coding-agent_MusicPractise\`。蒸馏日期 2026-10-15；2026-10-15 由 ZCode 会话修订（docs/37/38 落地状态）；2026-10-16 由 ZCode 会话修订（docs/39 云盘共享与关卡库迭代 H1–H6 全部落地，测试基线 723 → 805）。

## 项目定位

音乐教育 UGC 平台：关卡「创作 → 游玩 → 进度」全链路在浏览器完成。内容层级固定为 **系列 Series → 专题 Topic → 关卡 Level → 题目 Question**；关卡由组件实例拼装，逻辑用控制流图 GraphProgram v2 描述（「单一 IR 三视图」：伪代码/节点图/JSON 是同一 IR 的投影，确立「先设计代码再设计节点图」）。前端 SPA（Vite + React + TS strict）+ Cloudflare Workers 单通道后端 + D1。

## 命令与工程基线

- `npm run dev` 纯前端（5173，`/api` 代理到 wrangler 8787）；`npm run dev:worker` 全栈（先 `npm run build`）；`npm run db:migrate:local` 本地 D1 迁移；`npm test`（Vitest）；`npm run build` = `tsc --noEmit && vite build`。
- 质量门禁：全量测试全绿（现行基线 **805 项**）+ `tsc`/`build` 干净 + 关键交互浏览器实测；新特性必须带定向用例；P0/P1 缺陷当批闭环。
- 设计/评审/落地记录按编号归档 `docs/`（如 docs/02 数据结构契约、docs/27 数据表 2.0、docs/31 后端、docs/36 UI 全量重设计、docs/37 运行时 UI 改造、docs/38 编辑器界面改造）；数据模型或接口变更须同步对应文档与契约表。

## 目录与架构要点

- `src/engine/`：`expr.ts` 沙箱表达式求值器（Pratt 解析；作用域根仅 `$q./$event./$v.`；函数白名单 21 个；步数预算 1000；拒绝赋值/循环/原型逃逸；`==` 即严格相等）；`graphProgram.ts` IR v2 + lint；`graphEngine.ts` 异步执行器（wait/branch/loop、预算防死循环、generation 竞态作废）；`script.ts` `generateScript`/`parseScript` 伪代码↔IR 往返恒等；`migrate.ts`/`migrateDoc.ts` 迁移器；`rhythm.ts` rhythmScore/rhythmMatch 纯函数。
- `src/runtime/`：`levelSession.ts` 完全解耦 DOM/React（无头可驱动、`session.dispatch` 注入事件、`SessionHost.budgets` 限步）；`LevelStage.tsx` 800×470 fit-scale 共享舞台（玩家页与编辑器调试画面单一真源，`viewportClassName`/`canvasClassName` 是被测试钩住的契约）；`LevelRunner.tsx` 渲染薄壳（题面 `.stage-prompt` 主视觉条 / 进度条 / 结算 `.result-bar`，重玩常驻）；`audio.ts` `scheduleNoteEvents` 统一调度；`audioHost.ts` 共享音频；`store.ts` ComponentStore（useSyncExternalStore + effect sink）；`componentDef.ts` 组件为纯函数 reducer，统一 `events/commands/state` 契约。
- `src/editor/`：`EditorPage.tsx`（`#/edit/:id`）五 Tab = 画布/节点图/伪代码/数据表/JSON；`docState.ts` 唯一权威数据源（纯函数）；`graph/` 节点图编辑器与 Dock 五面板（组件库/事件管理/变量/属性/AI，第 6 个 DebugPanel）；`TableGrid.tsx` 数据表（一行 = 一题）；`StaffEditor.tsx` 五线谱弹窗；`ListEditor.tsx` 字符串列表弹窗。
- `src/ai/` 编辑器内 AI 助手：`providers/settings/client/agent/tools/tools-write/tools-debug/tools-plan/plan/runHarness/session/vision/checkpoint`。ask/plan/agent 三模式；写七件套 `write_script/edit_table/edit_components/edit_meta/edit_views/edit_flow/set_variable` 全走 `applyAndCheck` 管线（mutate → `loadLevelDoc` 校验 → `applyDoc`；被拒回喂自纠）+ 检查点回滚。
- `src/library/` Dexie 资源库（db / io 导入导出 / browse 文件夹树 / validate / manage 文件管理器与 bundle 收集纯函数）；`src/cloud/` 云盘（api 客户端 / `#/cloud` 我的云盘页 / 设置页摘要）；`src/hub/` 关卡库（`#/hub` 四 Tab：公共/精选/官方/群组 + GroupPanel 群组面板）；`src/components/` 组件与视图；`src/skin/` 皮肤系统（`#/skins`）；`src/admin/` 管理后台页（`#/admin` lazy）。
- `worker/` 单通道 API：http/router/session/ratelimit/admin（stats、用户 PATCH、关卡管理、审计分页）/password(pbkdf2)/`withSecurityHeaders`。`migrations/` 编号 SQL（0004 = audit_log）。`schemas/v1/` JSON Schema。`public/_headers` 静态安全头。
- 路由（hash）：`#/` 首页、`#/series/:id`、`#/library`、`#/cloud` 我的云盘、`#/hub` 关卡库（公共/精选/官方/群组）、`#/level/:id`、`#/edit/:id`、`#/graph/:id`、`#/settings`、`#/admin`、`#/docs`（含 `#/docs/changelog` 更新日志）、`#/skins`、`#/tuner`、`#/rhythm`。

## 硬性约定

- 版本判别：信封 `schemaVersion` 恒为 1，逻辑版本由 `logic.logicVersion: 2` 判别，内容结构为 schemaVersion 3。迁移铁律 **只增不改不删**，旧档「先放行后清洗」（迁移器清理，视图层不感知版本）。
- ID 一律 ULID 程序化生成，严禁手抄；组件 id 查重递增；`level` 与组件 id 为保留字；`__` 前缀系统变量（如行指针 `v.__row`）只归运行时，AI/工具禁写。
- 行指针语义：`v.__row` 赋值 = 原始行号（`order.indexOf` 反查）；越界忽略、严禁 clamp；shuffle 下读出再写回按同行 no-op。`level.next` 纯推进、换行靠 `loadRow` 刷新；视图不划分作用域、全局单图；`level.*` 仅 `started/finished/restart`。
- 组件数据应用只用 `call` 三命令 `setText`/`setOptions`/`setMusic`（静态 bindings 已废除）；共享映射收口 `engine/level.ts`：`DATA_APPLY_COMMANDS`/`DATA_APPLY_ACCEPTED_TYPES`/`COLUMN_TYPE_LABELS`（内层键是槽位名不是方法名，须按 `.method` find）。
- Schema 红线：`Note.dur` 白名单 `(1|2|4|8|16|32)n` 及附点变体；`NoteList` 上限 64；`Rule.on` 必须带 `.`/`:` 分隔符。
- 内置种子标 `builtIn` 禁删；就地编辑保存自动另存副本（新 ID，标题加「（副本）」，重复保存不叠加）；`ensureSeeded` 只补缺失、不覆写。导入导出冲突：**同 id 同版本跳过、异版本覆盖更新**；zip 条目 ≤50MB、整包 ≤100MB；产出 added/updated/skipped/rejected 报告。
- 样式走设计令牌：内容层旧 token 全部保留 + 语义扩展层（`--panel-2`/`--soft`/`--accent-soft` 系/状态软底两档/`--code-bg|--code-ink|--code-line` 等）+ v3 刻度令牌（`--sp-1..7`/`--r-sm..xl,pill`/`--fs-0..6`/`--shadow-1..3`/`--tr`）+ `--shell-bg`/`--shell-line`；换肤用 `documentElement.dataset.skin` + `:root[data-skin]` 整组覆盖。**主题裁决（docs/37/38）**：游玩页剧场 `.theater` 跟随皮肤（早期钉色深幕已撤）；舞台/画布内容层是浅色岛——`.stage-canvas`/`.editor-canvas` 钉全套内容 token + `--st-*` 子令牌（琴键/暗设备面板），乐谱可读性不随皮肤翻转；编辑器半独立主题——浅色模式走全局令牌随皮肤，深色模式 `--ge-*` 固定千星色板跨皮肤一致（☀/🌙 切换，localStorage `graph-theme` 默认深色）。测试契约类名 `.stage-viewport`/`.stage-canvas`/`comp-*`/`[data-midi]`/`.choice-item`/`.key`/`.tap-pad` 与组件文案（TAP/未开始等）、编辑器钩子（`.tlist-modal` 是 ListEditor 聚焦逻辑的 JS 依赖）不得随意改名。
- 面向用户的报错一律映射为可读中文（`client.ts` 七类错误映射），禁止裸抛；校验错误须带「行：列 + 消息」。
- 云盘共享契约（docs/39）：槽位合并口径 = 关卡槽位数 + Σ文件夹内含关卡数（上限 10）；系列/关卡同为可发布单元，发布为**快照制**（审核通过复制内容，更新需「更新发布」重审）；同 root_doc_id 在 public+official 视作同一命名空间（部分唯一索引，重复公开 409）；**源绑定锁定**——hub 条目 pending/published 期间云盘源删除 409 `publish_locked`（驳回/撤回/admin 移除解锁）；官方直传遇公共同内容 409 `already_in_public`，官方上限 200 条。
- 群组契约（docs/39 §5.3）：暗号必填全局唯一（NOCASE）+ 密码可选 pbkdf2；建群 ≤3/人、群库 ≤100 关、单成员 ≤30 关、单条目 ≤20 关（不占个人云盘额度）；群库条目 = hub_items scope='group'，群主或审核员批准/驳回；封禁群对外 404、成员访问 403 `group_banned`；解散显式级联（群库 docs/条目/成员）。`worker/handlers/groups.ts` 的 `deleteGroupCascade` 是群删除的唯一入口。
- React 纪律：Hooks 禁止放在条件早退之后（直接 URL 访问整页白屏）；高频交互以 ref 为真源 + 统一 commit 写入；全局快捷键用 window 级原生监听（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y，历史栈 cap 50，手动与 AI 修改同栈）；嵌套状态变更必须 `patchSession` 整对象替换、禁原地 mutation。

## 关键决策与理由

- ECA 规则引擎已被异步 GraphEngine 全面替代（需原生支持 wait/中断节点），LogicEngine 仅作等价基准。
- 音频：`AudioContext.currentTime` 唯一时钟（禁 performance.now）；调度收口 `audio.scheduleNoteEvents`（`Note` 带 `t`/`rest`，`mode` 仅运行时兼容键）；组件效果统一走 effect sink（曾因视图直调旁路全奏同一音高）；synth 六音色、参数严格钳制 + NaN 守卫（非法值沿增益总线毒化整轨）；velocity 用 MIDI 0..127（默认 100）；麦克风流 10Hz 节流。
- 后端：Workers 单通道 + D1，不引入多通道多存储。权限门禁在后端 `requireAdmin`（403），前端入口仅 UX 提示；级联删除显式逐表删（不依赖 FK）；审计写入与业务同成败。安全头双通道（静态 `public/_headers` + API `withSecurityHeaders`）；CSP `connect-src` 放开 `https:` 是有意裁决（AI BaseURL 可为任意域名）。
- 管理员只能经 `scripts/seed-admin.ts` 播种（注册不产生管理员）；远端播种用文件式三步：`node scripts/seed-admin.ts --nickname=admin --password=<密码> --out=seed-admin.sql` → `npx wrangler d1 execute musicpractise-db --remote --file=seed-admin.sql` → 删除临时 SQL。昵称用 ASCII。
- 无头验证闭环：`src/ai/runHarness.ts`（`run_level` 只读工具）= loadLevelDoc 预检 → LevelSession → 剧本化注入事件 → dispose 前采集变量终态。**Agent 守则：每次代码变更后必须 run_level 自验证**。
- AI 会话治理现行值：下发窗口 120 条（最近 48 条全量、更早 tool 结果截断 200 字符、不拆 assistant/tool_calls 对）；轮数上限 agent 32 / ask·plan 8，撞限出紫色「▶ 继续」恢复条（不重存检查点）；工具支持事务性批量参数（`vars`/`items`/`updates`/`ids`/`ops`/`events`），任一项失败整批不应用。
- Debug：`debugRun` 单例人机共享（AI 试玩全程可见）；暂停只在节点边界；stop 时必须 resolve 所有挂起门防死锁；变量快照读取用 400ms 轮询；可见游玩画面 800×470 fit-scale，右列宽 280–560px。

## 已知坑

- VexFlow 5 内联 style 覆盖 width → 用 `fitWidth` 等比缩放；`g.vf-stavenote` 数量与 notes 不齐时跳过命中区；jsdom 无 `getBBox` 必须防御回落。
- 键盘流/连续输入：React 闭包快照会过期，必须 ref 为真源并在 commit 统一写入；effect 依赖原始值不重跑 → `RhythmState.runId` 每次 start 递增强刷；节奏评分用相对起拍时间（绝对秒曾致恒 0 分）。
- `html-to-image` 在隐藏/遮挡容器挂起（rAF 不触发）→ 只抓节点卡层 + 8 秒竞速兜底；必要时以 setTimeout 补偿 rAF。
- 迁移产物 call 链严禁跨事件处理器共享节点（golden 往返丢节点），每入口独立成链；等价 golden 双跑时 v1 侧用 v1 原始行对照。
- Shell 转义红线：批量修改含 `$expr` 的关卡 JSON 用 Write 工具写脚本文件，不走 bash/PowerShell 内联（shell 会损坏 `$expr`；PowerShell 双引号会展开 `$100000` 类片段，曾致播种 INSERT 整条失效）。
- 数据表非标量值必须走 `JsonFallbackCell`、严禁 `String()` 兜底（曾泄漏 `[object Object]`）；新建列默认 text，先文本录入后切类型产生的脏数据曾是「编辑 JSON」死胡同根因（已全面弹窗化，紧凑记法 `C4 C#4 60 62:8n. r:4n` 由 `parseNoteTokens` 解析）。
- Windows：Vite HMR 用 `usePolling`（vite.config.ts，300ms）；僵尸 dev server 互相抢占端口需 taskkill；`.gitattributes` 强制 eol=lf。
- localStorage 键约定：`ai-settings`（AI 配置，Key 明文本地存）、`graph-panels/graph-panel-w-*`（面板宽）、`skin.prefs.v1`（皮肤元数据；二进制资产在 Dexie 库 skin-assets）。拖拽列宽每帧按「起始值 + 总位移」重算，逐帧累加会因 React 渲染滞后漂移。
- 资源库树循环引用防护：`browse.ts` 硬编码 3 层深度截断。进度写入 `progress` 表事务只存最高分（只升不降）、通过保持、`attempts+1`。
- CSS 同特异性「后者胜」两次实案：旧按钮基块写在组件层之后覆盖全站（已删，勿再在文件尾部补按钮基样式）；媒体查询里的规则会被文件尾同名区块覆盖——**媒体查询必须放在被覆盖区块之后**（theater 移动端规则实测踩坑）。
- 内容层浅色岛必须钉**全套**语义 token：只钉旧 10 token 不够，语义扩展层（`--accent-soft` 系等）同样会漂移进舞台（深色皮肤下琴键 hover 曾漂移）。空文本组件注意残留观感：`.comp-label:empty` 已透明化（反馈位初始空串 + tone 软底曾渲染成无字色块）。
- `--ge-*` 只在 `.graph-editor.ge-dark` 上定义：gdb-stage 区 `var(--ge-*, var(--*))` 双写是明暗双主题取值机制（浅色回落全局 token），**勿当冗余清理**。
- 浏览器实测（IAB/playwright）：transform 缩放容器（舞台）内 click 会卡 actionability，用 `locator.evaluate(el => el.click())`；localStorage 改皮肤后 hash 导航不重载页面，必须 `reload()`；`goto` 同 URL 是 no-op——**换构建后旧文档继续跑旧 bundle，必须显式 `reload()`**（H3 曾据此误判「新代码不生效」）。notes 列示例只在 synth-lab 关（其余示例关 data 列是 json），测五线谱弹窗别找错关。
- IAB 原生 JS 对话框（prompt/confirm）会被自动吞掉，`getJsDialog` 轮询不可靠——浏览器实测统一在页面内 stub `window.prompt/confirm`；Playwright `evaluate` 传**字符串按表达式求值**（箭头函数串不会自动调用，须 IIFE 或传真实函数）；React 受控 input 直改 `.value` 不生效（需 native setter 或派发 input 事件后由 React value tracker 放行）。
- 测试中 `{ ...sampleDoc }` 浅拷贝后改其 `content`/`meta` 会毒化模块级共享样本文档（import 是单例）——改 payload 必须 `JSON.parse(JSON.stringify())` 深拷贝；该坑曾致同文件用例顺序依赖的连环误报（docs/39 H2）。
- wrangler dev 的 TaskStop 杀不净子进程：8787 被热重载的旧实例占用时新实例被挤到 8789 且因本地 D1 SQLite 锁竞争崩溃，旧实例还可能在编辑中间态构建失败后带病服务——处置：`netstat -ano` 找 PID taskkill 清端口后重启（docs/39 H4）。
- 对返回 Promise 的校验函数（如 `verifyPassword`，签名 (password, stored)）必须 await 且勿颠倒参数序——布尔语境漏 await 不报错、只会恒真放行（docs/39 H5 曾致加入密码校验被绕过，单测抓住）。

## 待办与搁置（2026-10-16 修订）

- **云盘共享与关卡库已全部落地（docs/39，H1–H6）**：资源库文件管理器、云盘文件夹化、公共/精选/官方/群组关卡库、申请公开审核、admin 审核队列与官方/群组管理。后续候选：下载排行榜/排序参数、通知系统、拖拽整理、移动端适配（延续 docs/38 口径）。
- Bundle 瘦身已部分落地（vexflow/smplr/pitchy/fflate 惰性或动态 import、react vendor chunk，见 vite.config.ts；主包峰值曾 1.83MB/gzip ~906KB，目标 gzip ~450–550KB）；MusicXML 导入未启动。
- 移动端适配：游玩舞台已适配（批次12 fit-scale + 触屏），**编辑器等重交互表面的移动端适配未启动**（docs/38 裁决不纳入，当前为 0）。
- 编辑器 AI 遗留候选（有意搁置）：复合工具 `edit_level`、maxTurns 设置页配置化（现行固定 agent 32 / ask·plan 8）。
