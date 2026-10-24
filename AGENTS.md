# AGENTS.md — MusicPractise（音乐练习 UGC 平台）

> 本文件由 Hindsight 记忆库蒸馏而来（该服务已停用），深度历史资料见 `F:\hindsight\export\coding-agent_MusicPractise\`。蒸馏日期 2026-10-15；2026-10-15 由 ZCode 会话修订（docs/37/38 落地状态）；2026-10-16 由 ZCode 会话修订（docs/39 云盘共享与关卡库迭代 H1–H6 全部落地，测试基线 723 → 805）；2026-10-24 由 ZCode 会话修订（docs/40 编辑器审计、docs/41 R1–R12 修复、docs/42 独立验收、docs/43 R13 返工、docs/44 后续批次 R14/R15/R16a/R16b/R17a/R17b1/R18/R19/R20/R21/R22/R23/R24/R25/R26/R27/R28/R29/R30/R31/R32/R33 落地；测试基线 805 → 808 → 861 → 915 → 929 → 938 → 967 → 971 → 972 → 974 → 980 → 981 → 986 → 988 → 992 → 996 → 997 → 1001 → 1005 → 1008 → 1010 → 1011 → 1015 → **1016 项 / 113 文件**）。

## 项目定位

音乐教育 UGC 平台：关卡「创作 → 游玩 → 进度」全链路在浏览器完成。内容层级固定为 **系列 Series → 专题 Topic → 关卡 Level → 题目 Question**；关卡由组件实例拼装，逻辑用控制流图 GraphProgram v2 描述（「单一 IR 三视图」：伪代码/节点图/JSON 是同一 IR 的投影，确立「先设计代码再设计节点图」）。前端 SPA（Vite + React + TS strict）+ Cloudflare Workers 单通道后端 + D1。

## 命令与工程基线

- `npm run dev` 纯前端（5173，`/api` 代理到 wrangler 8787）；`npm run dev:worker` 全栈（先 `npm run build`）；`npm run db:migrate:local` 本地 D1 迁移；`npm test`（Vitest）；`npm run build` = `tsc --noEmit && vite build`。
- 质量门禁：全量测试全绿（现行基线 **1016 项 / 113 文件**，R33 后；历史见 docs/41/43/44；**全局 console 门禁已启用，非预期 console.error/warn 即失败**）+ `tsc`/`build` 干净（build 以 exit 0 + 无新增告警为准；vexflow >500kB 警告为已知项）+ **生产构建静态门禁 `npm run verify:dist`（R33：无内联 script / skin-boot 顺序 / CSP script-src self）** + 关键交互浏览器实测；新特性必须带定向用例；P0/P1 缺陷当批闭环；写路径性能改动先跑 `npm run bench:update`（R11 门控，docs/44 §5）；编辑器交互新增/修改需同时补 `data-testid`（G3 契约，见 `src/test/g3Anchors.test.ts`）；双用 hook class 从 `src/editor/editorHooks.ts` 引用（G14 契约）。
- 设计/评审/落地记录按编号归档 `docs/`（如 docs/02 数据结构契约、docs/27 数据表 2.0、docs/31 后端、docs/36 UI 全量重设计、docs/37 运行时 UI 改造、docs/38 编辑器界面改造）；数据模型或接口变更须同步对应文档与契约表。

## 目录与架构要点

- `src/engine/`：`expr.ts` 沙箱表达式求值器（Pratt 解析；作用域根 `q./event./v.`——`$` 前缀仅 v1 迁移输入，新代码禁用；含 `checkExprText` 实时校验下沉；函数白名单 21 个；步数预算 1000；拒绝赋值/循环/原型逃逸；`==` 即严格相等）；`graphProgram.ts` IR v2 + lint；`graphEngine.ts` 异步执行器（wait/branch/loop、预算防死循环、generation 竞态作废）；`script.ts` `generateScript`/`parseScript` 伪代码↔IR 往返恒等；`migrate.ts`/`migrateDoc.ts` 迁移器；`rhythm.ts` rhythmScore/rhythmMatch 纯函数。
- `src/runtime/`：`levelSession.ts` 完全解耦 DOM/React（无头可驱动、`session.dispatch` 注入事件、`SessionHost.budgets` 限步）；`LevelStage.tsx` 800×470 fit-scale 共享舞台（玩家页与编辑器调试画面单一真源，`viewportClassName`/`canvasClassName` 是被测试钩住的契约）；`LevelRunner.tsx` 渲染薄壳（题面 `.stage-prompt` 主视觉条 / 进度条 / 结算 `.result-bar`，重玩常驻）；`audio.ts` `scheduleNoteEvents` 统一调度；`audioHost.ts` 共享音频；`store.ts` ComponentStore（useSyncExternalStore + effect sink）；`componentDef.ts` 组件为纯函数 reducer，统一 `events/commands/state` 契约。
- `src/editor/`：`EditorPage.tsx`（`#/edit/:id`）五 Tab = 画布/节点图/脚本/数据表/JSON；`docState.ts` 唯一权威数据源（纯函数）；`graph/` 节点图编辑器与 Dock 五面板（组件库/事件管理/变量/属性/AI，第 6 个 DebugPanel）；`TableGrid.tsx` 数据表（一行 = 一题）；`StaffEditor.tsx` 五线谱弹窗；`ListEditor.tsx` 字符串列表弹窗。
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
- **编辑器写路径纪律（docs/40 §12.1 / docs/43 / docs/44 §5）**：所有文档修改走 `EditorPage.update` 单一入口（入撤销栈+标脏）；docState 变换恒返回新对象、全仓禁原地 mutation——历史栈因此按引用存档（勿加 clone）；**热路径变换采用结构共享（只复制 doc→content→变更分支，未变更分支保持引用），新增/修改 docState 变换必须遵守该约定**；update 的 `tag` 参数标记连续性（标题 'title'/单元格 'cell'/AI 每次 run 独立 `ai:<n>`/回滚 `rollback:<n>`，同 tag 连续合并为一条撤销步）。同步维护 `revision` 计数器（`getRevision`）供 AI 冲突检测。
- **编辑器历史语义（docs/40 §12.3 / docs/43）**：撤销栈引用 = cleanDocRef（保存基线）比对判脏，undo 回保存点自动清脏；AI run 复合事务（每 run 独立 tag）一次 Ctrl+Z 整段回退；checkpoint 是单级回滚（**agent 首次真正写入前懒存**，纯问答不产生；带 confirm+影响摘要，复位 plan）；回滚使用独立 tag（可 Ctrl+Z 撤销回滚）。内置副本另存时历史条目 remap id/version（undo 不改变文档身份）。新交互禁止逐帧/逐键无 tag 压栈。
- **运行归属纪律（docs/40 §12.4 / docs/42 §4.4）**：debugRun 与 AI run 都有宿主——graph Tab 不可见/编辑器卸载即 stopDebugRun；**AI run 归 EditorPage**：切 Tab/节点图调试布局不 abort，显式关闭 AiPanel（aiOpen=false）/卸载编辑器/内置副本保存才 stopAgent；ToolContext.signal 贯穿长等待工具；调试工具按 isDebuggingDoc 守卫跨文档操作、`debug_control(start)` 在会话非 idle 时拒绝；新增运行类功能必须声明 owner 与清理时机。
- **AI 冲突策略（docs/43）**：编辑器文档以用户为准。AI 写工具整文档回写前比对 revision——run 期间用户手改/撤销/保存过则**拒绝本次写入**并回喂「先 read 后重写」；冲突后 `runDoc` 置空、读工具走实时 doc（`getLiveDoc`），模型重读后可重试。AiPanel 卸载后 run 仍继续（applyRef/doc 读取经宿主），不得在面板 cleanup 里 abort。
- **测试钩子纪律（docs/40 G3 渐进口径）**：新增交互契约优先加 `data-testid` 供测试查询，不再新增对样式类名/精确文案的断言；既有类名契约（`.tlist-modal`→Modal 沿用、`.stage-*`、`.editor-*`、`comp-*`）不得随意改名。

## 关键决策与理由

- ECA 规则引擎已被异步 GraphEngine 全面替代（需原生支持 wait/中断节点），LogicEngine 仅作等价基准。
- 音频：`AudioContext.currentTime` 唯一时钟（禁 performance.now）；调度收口 `audio.scheduleNoteEvents`（`Note` 带 `t`/`rest`，`mode` 仅运行时兼容键）；组件效果统一走 effect sink（曾因视图直调旁路全奏同一音高）；synth 六音色、参数严格钳制 + NaN 守卫（非法值沿增益总线毒化整轨）；velocity 用 MIDI 0..127（默认 100）；麦克风流 10Hz 节流。
- 后端：Workers 单通道 + D1，不引入多通道多存储。权限门禁在后端 `requireAdmin`（403），前端入口仅 UX 提示；级联删除显式逐表删（不依赖 FK）；审计写入与业务同成败。安全头双通道（静态 `public/_headers` + API `withSecurityHeaders`）；CSP `connect-src` 放开 `https:` 是有意裁决（AI BaseURL 可为任意域名）。
- 管理员只能经 `scripts/seed-admin.ts` 播种（注册不产生管理员）；远端播种用文件式三步：`node scripts/seed-admin.ts --nickname=admin --password=<密码> --out=seed-admin.sql` → `npx wrangler d1 execute musicpractise-db --remote --file=seed-admin.sql` → 删除临时 SQL。昵称用 ASCII。
- 无头验证闭环：`src/ai/runHarness.ts`（`run_level` 只读工具）= loadLevelDoc 预检 → LevelSession → 剧本化注入事件 → dispose 前采集变量终态。**Agent 守则：每次代码变更后必须 run_level 自验证**。
- AI 会话治理现行值：下发窗口 120 条（最近 48 条全量、更早 tool 结果截断 200 字符、不拆 assistant/tool_calls 对）；轮数上限 agent 32 / ask·plan 8，撞限出紫色「▶ 继续」恢复条（不重存检查点）；工具支持事务性批量参数（`vars`/`items`/`updates`/`ids`/`ops`/`events`），任一项失败整批不应用。
- AI 编辑撤销/冲突现行值（docs/43）：检查点懒存于 agent 首次写入前（单级回滚）；每次 run 独立撤销 tag、回滚独立 tag；写前 revision 冲突拒绝并回喂重读；AiPanel 卸载不 abort（宿主 EditorPage 负责显式停止）。
- Debug：`debugRun` 单例人机共享（AI 试玩全程可见）；暂停只在节点边界；stop 时必须 resolve 所有挂起门防死锁；变量快照读取用 400ms 轮询；可见游玩画面 800×470 fit-scale，右列宽 280–560px。

## 已知坑

- VexFlow 5 内联 style 覆盖 width → 用 `fitWidth` 等比缩放；`g.vf-stavenote` 数量与 notes 不齐时跳过命中区；jsdom 无 `getBBox` 必须防御回落。
- 键盘流/连续输入：React 闭包快照会过期，必须 ref 为真源并在 commit 统一写入；effect 依赖原始值不重跑 → `RhythmState.runId` 每次 start 递增强刷；节奏评分用相对起拍时间（绝对秒曾致恒 0 分）。
- `html-to-image` 在隐藏/遮挡容器挂起（rAF 不触发）→ 只抓节点卡层 + 8 秒竞速兜底；必要时以 setTimeout 补偿 rAF。
- 迁移产物 call 链严禁跨事件处理器共享节点（golden 往返丢节点），每入口独立成链；等价 golden 双跑时 v1 侧用 v1 原始行对照。
- Shell 转义红线：批量修改含 `$expr` 的关卡 JSON 用 Write 工具写脚本文件，不走 bash/PowerShell 内联（shell 会损坏 `$expr`；PowerShell 双引号会展开 `$100000` 类片段，曾致播种 INSERT 整条失效）。
- 数据表非标量值必须走 `JsonFallbackCell`、严禁 `String()` 兜底（曾泄漏 `[object Object]`）；新建列默认 text，先文本录入后切类型产生的脏数据曾是「编辑 JSON」死胡同根因（已全面弹窗化，紧凑记法 `C4 C#4 60 62:8n. r:4n` 由 `parseNoteTokens` 解析）。
- Windows：Vite HMR 用 `usePolling`（vite.config.ts，300ms）；僵尸 dev server 互相抢占端口需 taskkill；`.gitattributes` 强制 eol=lf。
- localStorage 键约定：`ai-settings`（AI 配置，Key 明文本地存）、`graph-panels/graph-panel-w-*`（面板列宽）、`graph-dock/graph-dock-h/graph-dock-dbg-w/-h`（节点图 dock 布局与调试列尺寸）、`graph-theme`（节点图明暗，默认深色）、`graph-summary-mode`（节点摘要中英文）、`skin.prefs.v1`（皮肤元数据；二进制资产在 Dexie 库 skin-assets）；sessionStorage：`ai-kickoff:<docId>`（AI 新建关卡开工指令，按 docId 键控）。**FOUC 预置必须用外置 `public/skin-boot.js`**（`index.html` 内联脚本会被生产 CSP 拦截，见已知坑）。拖拽列宽每帧按「起始值 + 总位移」重算，逐帧累加会因 React 渲染滞后漂移。
- 资源库树循环引用防护：`browse.ts` 硬编码 3 层深度截断。进度写入 `progress` 表事务只存最高分（只升不降）、通过保持、`attempts+1`。
- CSS 同特异性「后者胜」两次实案：旧按钮基块写在组件层之后覆盖全站（已删，勿再在文件尾部补按钮基样式）；媒体查询里的规则会被文件尾同名区块覆盖——**媒体查询必须放在被覆盖区块之后**（theater 移动端规则实测踩坑）。
- 内容层浅色岛必须钉**全套**语义 token：只钉旧 10 token 不够，语义扩展层（`--accent-soft` 系等）同样会漂移进舞台（深色皮肤下琴键 hover 曾漂移）。空文本组件注意残留观感：`.comp-label:empty` 已透明化（反馈位初始空串 + tone 软底曾渲染成无字色块）。
- `--ge-*` 只在 `.graph-editor.ge-dark` 上定义：gdb-stage 区 `var(--ge-*, var(--*))` 双写是明暗双主题取值机制（浅色回落全局 token），**勿当冗余清理**。
- 浏览器实测（IAB/playwright）：transform 缩放容器（舞台）内 click 会卡 actionability，用 `locator.evaluate(el => el.click())`；localStorage 改皮肤后 hash 导航不重载页面，必须 `reload()`；`goto` 同 URL 是 no-op——**换构建后旧文档继续跑旧 bundle，必须显式 `reload()`**（H3 曾据此误判「新代码不生效」）。notes 列示例只在 synth-lab 关（其余示例关 data 列是 json），测五线谱弹窗别找错关。
- IAB 原生 JS 对话框（prompt/confirm）会被自动吞掉，`getJsDialog` 轮询不可靠——浏览器实测统一在页面内 stub `window.prompt/confirm`；Playwright `evaluate` 传**字符串按表达式求值**（箭头函数串不会自动调用，须 IIFE 或传真实函数）；React 受控 input 直改 `.value` 不生效（需 native setter 或派发 input 事件后由 React value tracker 放行）。
- 测试中 `{ ...sampleDoc }` 浅拷贝后改其 `content`/`meta` 会毒化模块级共享样本文档（import 是单例）——改 payload 必须 `JSON.parse(JSON.stringify())` 深拷贝；该坑曾致同文件用例顺序依赖的连环误报（docs/39 H2）。
- Vite HMR 不推送「弹窗级/条件渲染级」组件的改动（如 Modal 化的 StaffEditor）：页面已挂载场景下模块缓存不更新，表现为改动「不生效」——浏览器实测这类改动必须显式 reload（docs/40 R8 实测）。
- 合成事件（automation/测试）下 `setPointerCapture(假 pointerId)` 抛 InvalidPointerId 并中断后续处理器——EditorCanvas/GraphEditor 的拖拽入口已 try/catch 兜底；新写拖拽入口照 GraphEditor `startSplitDrag` 惯例（docs/40 R3）。
- wrangler dev 的 TaskStop 杀不净子进程：8787 被热重载的旧实例占用时新实例被挤到 8789 且因本地 D1 SQLite 锁竞争崩溃，旧实例还可能在编辑中间态构建失败后带病服务——处置：`netstat -ano` 找 PID taskkill 清端口后重启（docs/39 H4）。
- 对返回 Promise 的校验函数（如 `verifyPassword`，签名 (password, stored)）必须 await 且勿颠倒参数序——布尔语境漏 await 不报错、只会恒真放行（docs/39 H5 曾致加入密码校验被绕过，单测抓住）。
- **生产 CSP 禁止内联脚本**：`script-src 'self'`（`public/_headers` + `worker/http.ts` 双通道）会拦截 `index.html` 内联 `<script>`；本地 Vite dev 无此头、容易误判「生效」——FOUC/引导脚本一律外置（现为 `public/skin-boot.js` + `%BASE_URL%`），并靠 `src/test/bootstrapSecurity.test.ts` 静态互锁防止回退（docs/43）；**构建产物另由 `npm run verify:dist` 守卫（无内联 script/skin-boot 顺序/CSP/资源存在，R33）**，发布前必须跑。
- **脚本页锚点合并是启发式**：`mergeScriptAnchors` 按语句特征配对，仅对「配对成功且旧节点有坐标」的节点保留 id/x/y；二次编辑 s 前缀旧图、重排/插入/删除可能产生 id 冲突——合并后必须保证 id 唯一、无悬空边/自环，并在合并后跑 `loadLevelDoc` 预检（曾因写出 `x: undefined` 使保存/AI 写入全部失败，docs/42 §4.1）。
- **内置副本保存 = 文档身份迁移**：内置示例另存副本换 id 时，必须同步迁移按 docId 键控的状态（AI session/checkpoint/draftStore/runLog）、重映射撤销栈身份、切换 `activeId` 且 record 查询跟随；否则出现假「外部修改」横幅、undo 回退到内置 id、再保存建第二份副本（docs/42 §4.6）。
- **AI 写冲突检测依赖 revision**：宿主必须给 AiPanel 传 `getRevision`/`getLiveDoc`；只给引用快照会因 React 提交时序漏检（旧 `lastSeenExternal` 方案已被 docs/42 动态证伪）。新增写工具仍必须走 `applyAndCheck`（mutate→loadLevelDoc→applyDoc）。
- **AI 会话持久化（F10 / docs/44 R19）**：`aiSessions` 记录带 `schemaVersion`，hydrate 必须经 `sanitizePersistedSession`（未来版本拒绝、坏消息逐条清洗、400 条×200k 上限）；改动记录结构要提升 `AI_SESSION_SCHEMA_VERSION`；删除资源由 `deleteResource` 事务级联删 aiSessions，勿在 UI 层零散删。
- **受控 React Flow 单基线（O9 / docs/44 R19）**：GraphEditor 的 `apply` 用 `pendingDocRef` 维护同 task 最新基线（onNodesChange/onEdgesChange 或连续编辑不丢前一笔）；新增 change 处理器必须走 `apply`，禁止用渲染期 `doc` 闭包直接构造 next doc。
- **全局 console 失败门禁（H2 / docs/44 R20）**：`setup.ts` 安装 `consoleGate`——用例结束出现非预期 `console.error/warn` 即失败；测试平台噪音与夹具故意触发的负向诊断在 `consoleGate.GLOBAL_ALLOW` 按类别放行，**禁止向放行表加应用业务错误**；新负向用例优先 `withConsoleGuard(..., { allow })`；重建基线用 `CONSOLE_GATE_REPORT=1 npm test`（只写 tmp-console-gate.log）。
- **G3 锚点契约（docs/44 R21）**：编辑器关键交互必须有 `data-testid`（AiPanel 输入/发送/错误/计划、GraphEditor 面板开关/视图切换、节点卡 `graph-card-*`、palette `palette-item-*`、数据表 `tgrid-*`、Modal `modal`）；`src/test/g3Anchors.test.ts` 锁定关键锚点存在且高频测试不回退 class/文案查询——改编辑器 UI 时同步维护锚点与契约，不要新增对样式类名/精确文案的断言。
- **派生 token / 内容岛字体（G4/G5 / docs/44 R22）**：`--focus-ring`/`--shadow-*` 在 `:root` 一次性计算，**覆盖 `--accent`/`--shadow-rgb` 的作用域（ge-dark、内容岛等）必须重新声明派生 token**；内容岛只钉 `--font-*` 不够——body 的 font-family 已在根上计算并继承，必须同时在 `.stage-canvas/.editor-canvas` 上直接落 `font-family` 并覆盖 `--user-font-*`（内容层稳定性，用户字体不进入舞台/画布）。
- **双用 hook class / `--ge-*` 白名单（G14/G13 / docs/44 R23）**：`.editor-body`/`.editor-canvas`/`.tlist-modal`/`.gtoggle`/`stage-*`/`gdb-stage-canvas` 等是 JS/CSS/测试共用契约，统一从 `src/editor/editorHooks.ts` 引用，勿散落裸字符串；`var(--ge-*)` 只允许「33 条深色映射 + 5 处 gdb 双写 fallback」（R25 后），新增直用会被 `themeTokens.test` 拦截（浅色主题会静默失效）。
- **深色工作台裸色（G8 / docs/44 R25）**：`.ge-dark` 主题区只允许调色板定义、`rgba(var(--ui-shadow-rgb))` 阴影与白/黑遮罩原语；画布缩略图叠色走 `--ui-map-box-bg`（第 33 个语义 token），不要再写字面量（裸色扫描会失败）。
- **z-index / 弹窗外壳（G10/G12 / docs/44 R24）**：新增浮层必须用 `--z-*` 语义令牌（`themeTokens.test` 守卫 15 条声明/无裸数值；档位值保留既有精确值，合并 5 档需视觉矩阵）；弹窗外壳用通用 `.modal-backdrop/.modal-shell/.modal-head`，`.tjson-*` 是兼容 alias——新弹窗不要再只写 `.tjson-*`（`modalShell.test` 守卫）。
- **动效 / 舞台 fit（G11 / docs/44 R26）**：`prefers-reduced-motion: reduce` 降级块固定在 index.css 文件尾（`motionPreference.test` 守卫；新增媒体查询不要放到它之后）；LevelStage 缩放统一走纯函数 `computeStageFit`，ResizeObserver 回调必须 rAF 合并 + `Object.is` 等值短路（尺寸不变返回旧 state，避免舞台整树重渲染）。
- **同特异性覆盖 / 死声明（G7 / docs/44 R27）**：基础块不要写会被后置同特异性规则覆盖的属性（`.editor-canvas-layout` 的 flex-wrap/align-items 已删除，三栏规则统一到后置 nowrap/stretch）；媒体查询必须晚于被覆盖基础规则；`.tjson-modal.tlist-modal`/`.modal-shell.tlist-modal` 双类宽度覆盖靠特异性而非顺序——`g7Css.test` 守卫，改选择器先跑它。
- **React Flow 主题色（G9 / docs/44 R28）**：`<Background color>`/`<MiniMap nodeColor/nodeStrokeColor>` 一律传 `var(--ui-*)`（RF 写入 `--xy-*-props` CSS 变量，明暗由 `.graph-editor`/`.ge-dark` 作用域解析），禁止裸 hex——浅色主题会误用深色色值；`g9RfTheme.test` 守卫。
- **CSS 完全重复规则（G15 / docs/44 R29–R30）**：不允许「同选择器 + 完全相同声明」的重复规则，也不允许被后置同选择器规则完全覆盖的非 important 死声明（`g15Css.test` 守卫，防回涨）；清理/合并同名但不同声明的选择器前必须分类（令牌对齐/皮肤/媒体查询）并跑视觉矩阵——G15 冲突组残余仍开放。
- **文档与代码互锁（docs/40 I7–I16 / docs/44 R31）**：Tab 名、表达式作用域根、GraphEditor localStorage 键、docs/36 令牌清单由 `docsConsistency.test` 从代码反查文档——改这些真源时必须同步 README/AGENTS/docs29/docs36，否则测试失败；外部门禁（视觉矩阵/G15 冲突/G11 残构/生产 CSP）见 **docs/45**，未执行矩阵不得写成闭环。

## 待办与搁置（2026-10-23 修订）

- **R13 后仍开放（后续批次见 docs/44）**：G2 `.ge-dark` 剩余结构性收敛与视觉矩阵（R17a 语义 token 层 + R17b1 单色规则首批收敛：17 选择器提升、选择器行 158→143、预算 ≤143 防回涨；像素矩阵仍外依赖）、G3 视觉回归（R15 起步、**R21 锚点扩到 127 处/静态唯一 52 并加静态契约**；视觉 smoke 仍外依赖）、H2 视觉覆盖（R15 canvas 噪音清零、**R20 全局 console 门禁已闭环**；浏览器视觉矩阵仍外依赖）、G4/G5 已由 R22 落地、G13/G14 已由 R23 落地、G10/G12 已由 R24 落地、G6/G8 已由 R25 落地、G11 主要项已由 R26 落地（选中态伪元素/边阴影重构仍开放）、G7 已由 R27 闭环、G9 已由 R28 落地、**G15 已由 R29–R30/R32 清理完全重复规则/死声明/.level-canvas（56 组冲突组仍开放）**、**I7–I16 文档漂移已由 R31 校正**、编辑器移动端适配。**R16a/R16b 已闭环 F8/F13/F18/F19/F9/E18/O2/A5/F6**，**D1 已由 R14 闭环**，**R18/R11 热路径 patch 化已完成**（基准 P95 0.02–0.03ms；增删/整表深拷贝为残余；bundle 评估暂不改造，docs/44 §5），**R19 已闭环 F10/O9**（docs/44 §6），**R20 已闭环 H2 console 门禁**（docs/44 §7），**R21 已落地 G3 锚点增量**（docs/44 §8），**R22 已落地 G4/G5 机制**（docs/44 §9），**R23 已落地 G13/G14**（docs/44 §10），**R24 已落地 G10/G12 机制**（docs/44 §11），**R25 已落地 G6/G8**（docs/44 §12），**R26 已落地 G11 主要项**（docs/44 §13），**R27 已闭环 G7**（docs/44 §14），**R28 已落地 G9 机制**（docs/44 §15），**R29–R30 已落地 G15 清理**（docs/44 §16–§17），**R31 已落地文档互锁 + docs/45 外部门禁清单**（docs/44 §18），**R32 已落地 G15 .level-canvas 清理**（docs/44 §19），**R33 已落地生产构建静态门禁 verify:dist**（docs/44 §20）；R17b2（剩余收敛+视觉矩阵）待外依赖。
- **云盘共享与关卡库已全部落地（docs/39，H1–H6）**：资源库文件管理器、云盘文件夹化、公共/精选/官方/群组关卡库、申请公开审核、admin 审核队列与官方/群组管理。后续候选：下载排行榜/排序参数、通知系统、拖拽整理、移动端适配（延续 docs/38 口径）。
- Bundle 瘦身已部分落地（vexflow/smplr/pitchy/fflate 惰性或动态 import、react vendor chunk，见 vite.config.ts；主包峰值曾 1.83MB/gzip ~906KB，目标 gzip ~450–550KB）；MusicXML 导入未启动。
- 移动端适配：游玩舞台已适配（批次12 fit-scale + 触屏），**编辑器等重交互表面的移动端适配未启动**（docs/38 裁决不纳入，当前为 0）。
- 编辑器 AI 遗留候选（有意搁置）：复合工具 `edit_level`、maxTurns 设置页配置化（现行固定 agent 32 / ask·plan 8）。
