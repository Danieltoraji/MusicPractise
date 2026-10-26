# docs/50 · 关卡进程模型统一设计：`score` / `row` 双状态 + 结算判定入图

> 状态：**设计提案 · 已作废**（2026-10-26 出稿；2026-10-27 用户确认放弃旧关卡兼容，转向 v4 干净设计）。
> **本方案不再执行**：其兼容迁移/`migrationRev` 路线已被 [docs/51](51-关卡运行时v4种子设计（流程main与题型函数）.md) 取代；本文仅保留作讨论历史记录。
> 调研基线：`npm test` 1019/1019 通过（114 文件，43.4s）；工作区除既有 `docs/MusicPractise.code-workspace` 外干净。
> 关联：docs/02（数据结构）、docs/20（v3 文档）、docs/25（行指针语义）、docs/26（行数据应用）、docs/27（scoring 数值化）、docs/30（调试）、docs/37（运行时 UI）、docs/40/41/44（编辑器风险与批次）。
> 本文是对用户提案「计分完全由 `score` 变量控制 / 当前题目完全由 `row` 变量控制 / 结算、通关判定放进节点图」的设计评估与落地方案。

---

## 0. 结论摘要

### 0.1 对三条主张的判断

| 用户主张 | 判断 | 一句话说明 |
| --- | --- | --- |
| 计分完全由 `score` 变量控制 | **方向正确，需要从"命名约定"升级为"保留变量契约"** | 现状已经是"结算时读 `vars.score`"，但 `score` 可被改名/删除/写成非数字而静默变 0 分；且没有任何其它隐式加分区。要做的是把这条约定变成受保护的契约（编辑器锁名、装载期补齐、类型 lint、运行时数值归一），而不是引入新计分机制。 |
| 当前题目完全由 `row` 变量控制 | **方向正确，但不能字面理解为 `row + 1` 即下一题** | 你说的 `row` 就是现行系统变量 `v.__row`（赋值即跳题、原始行号语义）。在 `shuffle`/`count` 下"下一题的原始行号"不是 `row+1`，且旧档行门控依赖原始行号；因此 `row` 应成为**唯一可写题目指针**（`pos` 降为派生缓存），但序列推进仍保留 `question.next` 这一个运行时原语。若坚持"图里写 `v.row = v.row + 1`"，需要把行语义改为"局内位置游标"并引入第二个原始行号变量——成本高、不推荐本轮（见 §3.2）。 |
| 结算、通关判定放进节点图 | **完全成立，且可实现** | `level.finish` 目前只能强制失败（`passed:false`），图无法决定"通过"；末题自动结算发生在宿主内部，图不可介入。目标：`level.finish({ passed: <expression> })` 双向显式结算 + `flow.pass` 删除 + 末题不再隐式结算、改派 `question.ended` 事件交图判定。宿主只保留"执行结算"的副作用（幂等、停表、`onFinished`、结果条、进度落库）。 |

**一句话目标模型：两个状态变量（`score`、`__row`）+ 一个结算原语（`level.finish`）+ 一个结束事件（`question.ended`）+ 图内判定；`flow` 退化为出题配置（`order`/`count`）。**

### 0.2 现状的主要不统一（详见 §2）

- **P0：三条结算路径**并存——`flow.pass` 表达式、末题 `question.next` 隐式 `finish()`、图内显式 `level.finish()`；同一概念三个来源。
- **P0：`flow.pass` 是图外的平行判定 DSL**——FlowEditor + ConditionBuilder 与节点图的 branch/ConditionBuilder 重复，违背"单一 IR、先设计代码再设计节点图"。
- **P1：`score` 是魔法命名无契约**——改名/删除/写字符串都没有装载拦截，只会静默 0 分或 `flow.pass` 降级未通过。
- **P1：`row` 不是唯一真源**——`pos`（会话）+ `row` 对象 + `vars.__row`（镜像）三份状态；`question.next` 绕开行指针推进；处理链内跳行后 `q` 仍是旧行快照（docs/25 §4 已把该坑记录在案）。
- **P1：`level.finish` API 单向**——`passed:true` 无法覆盖 `flow.pass` 的 false，图无法实现"提前通关"。
- **P2：默认模板是死链**——`blankLevelDoc` 的 `on level:correct → score+10` 没有任何组件会发出 `level:correct`，而 `flow.pass v.score>=10` 永远不满足；新关卡从模板出发既不会计分也永远不会通过。
- **P2：样例终局二态**——10 个内置关中 9 个靠末题自动结算、只用 `flow.pass` 判通过；只有 `tutorial-hello` 在图里显式 `level.finish`（却仍由 `flow.pass` 决定 passed）。
- **P2：文档/UI 漂移**——`AGENTS.md:29` 仍写 `level.next`；palette 写"越界自动钳制"而实现是"越界忽略"；Inspector 把 `level.finish` 标为"无参数"但实现支持 `{passed:false}`；应用内文档仍教 `flow` 过关线。

### 0.3 方案与批次（详见 §8、§9）

- 兼容策略：引入 **`content.migrationRev: 2`** 语义版本标记；装载期自动迁移（把旧 `flow.pass` 编译为 `level.finish` 的 `passed` 实参 + `on question.ended → level.finish` 处理器），旧档行为不变、迁移幂等；**`schemaVersion` 不升级，schema 只增不改不删**。
- 落地分 4 个不可少批次（B1 核心语义+迁移 / B2 编辑器创作面 / B3 AI+校验诊断 / B4 文档+门禁验收），B1–B3 必须同一发布窗口；另有可选 B5（`__row` 公开改名 `row`）。
- 测试预计 1019 → 约 1040+（新增 20–25 例，更新约 20 个文件、10 份样例 JSON、3 份 schema）。完整清单见 §10。

### 0.4 需要你拍板的决策（§8）

D1 结束事件方案、D2 `__row` 是否改名、D3 `q` 是否实时、D4 `score` 保护强度、D5 无结算处理器的兜底策略、D6 `flow.pass` schema 永久保留。每项均给了推荐值与备选。

---

## 1. 现状盘点（事实与证据）

### 1.1 "当前题目"的状态真源

`src/runtime/levelSession.ts`：

| 状态 | 位置 | 语义 | 证据 |
| --- | --- | --- | --- |
| `order` | `levelSession.ts:51,71-78` | 本局题目顺序（原始行号数组）；`flow.order:'shuffle'` 时 Fisher–Yates，`flow.count` 截断 | 构造期一次性生成 |
| `pos` | `levelSession.ts:52` | **真源**：本局第几题（0 起） | `index`/`total` getter：111-117 |
| `row` | `levelSession.ts:54` | 当前表格行对象（`q` 作用域数据） | `loadRow` 写入：181-193 |
| `vars.__row` | `levelSession.ts:189` | 当前**原始行号**镜像；赋值即跳题 | 引擎 assign 钩子：`graphEngine.ts:248-260`；跳行：`levelSession.ts:195-206` |
| `finishedFlag` | `levelSession.ts:53` | 结算终态 | `finish`：334-356；跳行忽略：201 |

- `loadRow(p)`：停计时器 → 写 `pos/row` → **直写** `vars.__row = order[p]`（绕钩子防递归，:189）→ `onRow` → 派发 `question.loaded {index,total,row}`（:190-192）。
- `jumpToRow(raw)`：`finishedFlag`/空局忽略（:201）；`order.indexOf(raw)` 反查（:203）；越界/同行 no-op（:204）；非数字由引擎报错（`graphEngine.ts:251-257`）。
- `question.next`：`pos + 1`，末题直接 `finish()`（:222-228）。
- **结论**：行指针是"镜像"，`pos` 才是文档所述"纯推进"的真源；`row + 1` 只在 `sequential` 且 `count=null` 时等价于下一题。

### 1.2 计分状态

- `score` 是**普通声明变量**：默认模板声明 `variables:{score:0}`（`docState.ts:31`），示例关卡在"答对"分支手写 `v.score = v.score + q.scoring`（如 `note-click.level.json` 加分链路）。
- 结算唯一读取点：`levelSession.finish` 的 `const score = this.engine.vars.score ?? 0`（`levelSession.ts:353`）。
- 下游：`onFinished` → `LevelPage` 的 `saveProgress(Number(result.score) || 0, passed)`（`LevelPage.tsx:20-29`）→ `db.saveProgress`（`db.ts:160-175`，bestScore 只升不降）→ 首页/系列页徽章（`HomePage.tsx:12-20`、`SeriesPage.tsx:105-116`）；结果条显示 `得分 {String(finished.score)}`（`LevelRunner.tsx:116-137`）。
- 没有任何隐式加分区；`q.scoring` 只是数据表列，由作者图决定怎么用（docs/27）。
- **缺陷**：`score` 可被变量面板改名/删除（`VariablesPanel.tsx:20-21` 只过滤 `__` 前缀；`graphProgram.ts:199-229` 只保护 `__row`）；改名后结算静默 0 分，`flow.pass v.score>=…` 还会因未知属性降级未通过（`levelSession.ts:340-347`）；非数字分数原样进结果条、`Number()` 时才强转。

### 1.3 结算与通关判定（三条路径）

1. **`flow.pass`**：`content.flow.pass.expr`，`finish()` 里 `engine.evaluate(expr)` 求值（`levelSession.ts:339-347`）；缺省视为通过，求值失败降级未通过；结果进 `level.finished {score,passed}`（:355）。
2. **末题自动结算**：`question.next` 在最后一题直接 `finish()`（`levelSession.ts:222-228`），图不可介入。
3. **显式 `level.finish`**：`handleCommand` 只处理 `args.passed === false` 强制未通过（`levelSession.ts:233-237,350`）；`passed:true` 无法覆盖 `flow.pass=false`。

`level.finished` 是**终态**：`finish` 幂等（:337）、停全部计时器（:352）、先 `onFinished` 后派发事件（:354-355）。调试/AI 的 `finished` 快照读取同一回调（`debugRun.ts:207-209`、`runHarness.ts:86-88`）。

### 1.4 事件时序

GraphEngine 的 `dispatch` 是异步入队 FIFO（`graphEngine.ts:152-185`）；同一事件多个处理器按程序顺序串行；处理器作用域在起点构建：`event` 负载快照、`q` 当前行快照、`v` 活引用（`graphEngine.ts:189`）。

`start()`（`levelSession.ts:142-147`）：
```
level.started {title} → view.entered {view} → question.loaded {index,total,row}
```
结算：`levelSession.finish` → `host.onFinished` → `level.finished {score,passed}`。

### 1.5 编辑器 / AI 创作面

| 面 | 现状 | 证据 |
| --- | --- | --- |
| `flow` 结构化编辑 | 「推进与过关」编辑条：顺序/题数/过关条件勾选 + ConditionBuilder | `FlowEditor.tsx:36-64,104-133`；挂在 `TableGrid.tsx:207` |
| `flow` 默认值 | 空白关 `flow:{order:'sequential', pass:{expr:'v.score >= 10'}}` | `docState.ts:10-49` |
| JSON 页 | 直接编辑整份 JSON，应用走 `loadLevelDoc` | `EditorPage.tsx:1114-1191` |
| AI 写工具 | `edit_flow` 可改 order/count/pass.expr | `tools-write.ts:608-627` |
| AI 提示词 | 目录中无 `question.ended`；结构说明写 `content.flow：推进与过关条件（pass.expr）` | `prompts.ts:116-119,165,203-205` |
| 图节点库 | `question.next` 描述"末题则结算"；`level.finish` 描述可传 `{passed:false}`；模板 `tpl-score-gate` 在 `question.loaded` 上按阈值 `level.finish()` | `palette.ts:108-155,188-192` |
| Inspector | `level` 方法一律标"无参数"；`question.next` 同 | `NodeInspector.tsx:99-102` |
| 变量面板 | 仅 `__` 前缀特殊处理（`__row` 常驻说明行）；`score` 与普通变量一致可改名/删除 | `VariablesPanel.tsx:20-21,39-47` |
| 平台内文档 | 「flow 推进与过关」「过关线由 flow 配置决定」；脚本示例仍用 `level.next` | `docsContent.tsx:180-193,424-447,533` |

### 1.6 内置样例（10 关）

公因子：8 个数据关的"下一题"按钮同构 `if (!v.done) question.next() else level.restart()`；`level.finished` 处理器只做表现层（`done`、按钮文案、结果文案、音效），从不调用 `finish/restart`。

| 关 | 计分 | 结束方式 | pass |
| --- | --- | --- | --- |
| tutorial-hello | 答对 `+q.scoring`（answered 锁） | **图内显式 `level.finish`**（s3_next） | `v.score >= 10` |
| synth-lab | 无 score | 末题 `question.next` 自动结算 | 无（默认通过） |
| note-click | `+q.scoring` | 末题自动结算 | `v.score >= 20` |
| theory-choice | `+q.scoring` | 末题自动结算 | `v.score >= 10` |
| clef-test | `+q.scoring` | 末题自动结算 | `v.score >= 30` |
| melody-dictation | 门控 + `+q.scoring` | 末题自动结算 | `v.score >= 20` |
| note-spelling | 门控 + `+q.scoring` | 末题自动结算 | `v.score >= 20` |
| timed-reaction | 门控 + `+q.scoring` | 末题自动结算 | `v.score >= 20` |
| rhythm-follow | `+round(event.score*q.scoring)` | 末题自动结算 | `v.score >= 15` |
| tune-intro | scored 锁 + `+q.scoring` | 末题自动结算 | `v.score >= 20` |

### 1.7 测试与文档约束（改动前必须知道）

- `builtinEquivalence.test.ts:136-193`：8 个 v1 夹具经迁移器产出的 `logic` 必须与入库的 v3 样例**逐字段相等**（:140），并做变量终态/命令序列双跑等价。夹具是永久输入，改迁移器必须同步重生成 8 份样例。
- `levelSession.test.ts:126-140,159-170` 直接依赖 `flow.pass` 求值与末题自动结算；`tutorial.test.ts:97-109,135-175` 依赖 `level.finished {score,passed}` 与 synth-lab 末题自动结算；`runHarness.test.ts:35-37` 依赖结算报告。
- `validate.test.ts:197-240`、`editorPage.test.tsx:1023-1049` 锁 `flow.pass` 语法 lint（F6）；`editorUi.test.tsx:416-535` 锁 FlowEditor 结构/类名；`palette.test.ts:87-135` 锁模板节点数；`docState.test.ts:118-137` 锁 `setFlow` 的 pass 归一化。
- G3 锚点（`g3Anchors.test.ts`）：编辑器关键交互必须有 `data-testid`；G15（`g15Css.test`）会拦住 FlowEditor 删除 pass 区留下的死 CSS；docsConsistency（`docsConsistency.test.ts`）当前未锁 flow/score，可在 B4 加锁防回退。
- 全局面板文案/类名契约：`.flow-editor/.flow-field/.flow-pass` 等目前被测试锁（属渐进迁移对象）；`__row` 的守卫/隐藏/豁免/调试禁写在 `graphProgram.ts:57-58,199-229,363-364`、`debugRun.ts:309-311`、`tools-write.ts:648-649` 已形成完整模板，可直接复用到 `score`。

---

## 2. 设计审计：现状是否统一、优雅？

**结论：方向是对的，但现状是历史迭代形成的"过渡态"，不是统一设计。** 主要表现在五个"同一概念多个来源"：

| 编号 | 问题 | 证据 | 后果 | 严重度 |
| --- | --- | --- | --- | --- |
| P0-1 | 结算有三个入口（flow.pass / 末题自动 / 显式 finish） | `levelSession.ts:222-228,334-356`；`FlowEditor.tsx:36-133`；`tutorial-hello` vs 其余 9 关 | 作者无法在一个地方读懂"关卡何时结束、为什么通过"；文档需同时解释三套 | P0 |
| P0-2 | 通关判定是图外的平行 DSL | `flow.pass` + FlowEditor 的 ConditionBuilder（与图 branch 同款控件两套） | 违背"单一 IR 三视图"；图里看不到判定；调试/运行日志看不到 pass 求值；表达式作用域 `event` 还是空对象 | P0 |
| P1-1 | `score` 只是魔法命名 | `levelSession.ts:353`；`graphProgram.ts:199-229` 只保护 `__row`；`validate.ts:294-304` 只查 pass 语法 | 改名/删除→静默 0 分；类型漂移→结果条显示非数字；AI/作者无从得知这是保留名 | P1 |
| P1-2 | "当前题目"三份状态，`row` 非真源 | `pos:52` / `row:54` / `vars.__row:189`；`question.next` 绕开行指针（:222-228）；`q` 快照（`graphEngine.ts:189`，docs/25 §4 已知坑） | 作者在链上先 `v.__row=N` 再读 `q` 拿到旧行；`row+1` 在 shuffle 下不等价于下一题；进度/题号/行号三个数字容易混 | P1 |
| P1-3 | `level.finish` API 单向 | `levelSession.ts:233-237,350` | 图无法实现"达标提前通关"，也无法用分数阈值判通过（只能靠 flow.pass） | P1 |
| P2-1 | 默认模板死链 | `docState.ts:31-46`：`on level:correct` 无组件发出，`flow.pass` 永不满足 | 新建关从模板出发既不计分也永不通过；编辑器"推进与过关"有 UI 但无执行者 | P2 |
| P2-2 | 样例终局二态 | 9 关自动结算 vs tutorial 显式 finish；9 关用 pass、2 关不用 | 示例互相矛盾；迁移/教学成本 | P2 |
| P2-3 | 编辑器/文档漂移 | `palette.ts:210` 写"越界自动钳制"（实现忽略）；`NodeInspector.tsx:100` 标 finish"无参数"；`AGENTS.md:29` 仍写 `level.next`；`docsContent.tsx:193,440` 仍教 flow 过关线 | 作者按文档操作会踩空 | P2 |
| P2-4 | 条件编辑能力重复 | `FlowEditor` 的 ConditionBuilder 与图 branch 的 ConditionBuilder 是同一套控件、两处语义 | 维护两份口径，功能演进必然漂移（F6 lint 只为 pass 单独打补丁就是证据） | P2 |

**判断**：用户的三条原则恰好对应上述 P0-1/P0-2/P1-1/P1-2——说明设计直觉是对的；现在缺的不是"再加一套规则"，而是**收口**：把"关卡进程"收敛为两个状态变量 + 一个图内判定入口。

---

## 3. 对三条原则的逐条评估

### 3.1 「计分完全由 `score` 变量控制」——合理，但要补契约

- **合理**：现状确实只有 `v.score` 一个计分状态，`q.scoring` 只是数据；结果条/进度存档都从它来。没有"隐藏加分"需要删除。
- **需要补的契约**（否则"完全由它控制"在实现上只是"恰好读它"）：
  1. **保留名**：`score` 不允许改名/删除（编辑器变量面板、`graphOps`、AI `set_variable` 三处守卫；参照 `__row` 的既有实现 `graphProgram.ts:199-229`）。
  2. **恒存在**：装载期规范化时缺失则补 `variables.score = 0`（"先放行后清洗"惯例，迁移器已在做同类规范化，如列类型、`views[].template`）。
  3. **类型**：初值必须是有限数字（lint）；运行时结算前做数值归一，非数字按 0 并产生可定位的运行日志错误（不静默）。
  4. **单一读取点**：结算只读 `v.score`；`level.finished {score}`、`onFinished`、结果条、进度落库全部使用同一个归一后的数字（类型从 `Json` 收紧为 `number`）。
- 模板/示例/AI 提示词统一用 `score`；`q.scoring` 保留为"每题分值"数据列，由作者图自由使用（不引入平台隐式加分）。

### 3.2 「当前题目完全由 `row` 变量控制」——合理，但必须先定义 `row` 的语义

"row"有三种可能语义，直接决定实现成本：

| 语义 | 含义 | `row+1` 是下一题？ | 行门控（旧档 `v.__row==i`） | 与数据表题号一致 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **A 原始行号（现行 `v.__row`）** | 当前题目在数据表中的行号 | 否（shuffle/count 下会跳错/越界） | 天然一致 | 一致 | **推荐**：本轮保持语义不变，只做权威化 |
| B 局内位置游标 | 本局第几题（0..total-1） | 是 | 需要第二个"原始行号"系统变量，否则旧档门控全错 | 不一致（shuffle 下 `row` 与表行号不同） | 需重构顺序模型 + 迁移门控 + 全部文档，成本高 |
| C 展示序号（1 起） | "第 N 题" | 时对时错 | 需要换算 | 屏幕一致、数据不一致 | 不推荐 |

**推荐 A（保持 `v.__row` 的原始行号语义）**，同时做三件事让它"完全控制当前题目"：

1. **权威化**：会话的 `pos` 降为派生缓存；唯一的题目切换入口是"写行指针"（图赋值或 `question.next`），`loadRow` 是唯一装载点。加测试不变式：任意时刻 `pos === order.indexOf(v.__row)`。
2. **`question.next` 保留为序列推进原语**：只有运行时知道 `order`（shuffle/count）；表达式作用域只有 `v/q/event`（`expr.ts` 作用域根），没有 `len(rows)`/`order`/`total`，硬把"下一题"塞给图只能靠镜像 `event.total` 变量，既繁琐又易错。**`question.next` 就是 row 指针的"下一题"写入原语**，与 `v.__row = N`（跳题原语）并列。
3. **`q` 升级为实时视图（推荐，D3）**：处理链内跳行后，后续节点读到的 `q` 应该是新行而不是旧行快照（旧行为见 docs/25 §4 "边界备忘"）。实现只需把 `graphEngine.runHandler` 的 `scope.q` 从快照改成 getter（`graphEngine.ts:189`），求值器每次访问 `scope.q` 都从宿主取当前行；成本可忽略，收益是"row 变了，当前题目就变了"这条语义自洽。

**关于命名**：作者侧目前写作 `v.__row`。是否改名为公开的 `v.row` 见 D2——这不是语义核心；若改，必须处理"旧档里用户已声明同名变量 `row`"的撞名迁移，并重写 49 处代码引用与 22 处文档，建议独立批次。

**如果坚持"图里写 `v.row = v.row + 1`"（语义 B）**：需要新增"局内位置"游标 + 保留"原始行号"只读变量供门控，暴露 `total`，迁移所有 `v.__row` 门控与跳题写法，并重写全部样例/文档；且数据表"题号"与 `row` 在 shuffle 下不再一致，作者心智更重。**不推荐本轮**。

### 3.3 「结算、通关判定放进节点图」——完全成立

**要区分两件事**：

- **判定（decision）**：何时结算、通过与否 → 属于关卡逻辑，应进图。
- **执行（effect）**：幂等守卫、停计时器、`onFinished`、结果条、进度落库、`level.finished` 派发 → 属于宿主运行时，不应进图（图节点无法安全地"重复结算"）。

现状缺口正好卡在"判定无法表达"：

- `level.finish` 只有 `passed:false` 能生效（`levelSession.ts:233-237,350`）；
- 末题自动结算在宿主 `question.next` 内部（:222-228），图无法在结算前做分支；
- `flow.pass` 是图外表达式，作用域 `event={}`，调试/运行日志不可见。

**目标写法**（IR 与伪代码，均不需要改 IR/脚本投影——call 参数本来就是表达式文本，`graphEngine.ts:242-247` 只取 `args[0]` 求值）：

```jsonc
// 末题结束：图里判定 + 显式结算
{ "id": "on_ended", "kind": "on", "event": "question.ended" },
{ "id": "settle", "kind": "call", "target": "level", "method": "finish",
  "args": ["{ passed: v.score >= 60 }"] }
// 边：on_ended → settle
```

```
on question.ended {
  level.finish({ passed: v.score >= 60 })
}
```

复杂形态（通过/未通过要展示不同视图）：

```
on question.ended {
  if (v.score >= 60) { views.goto('pass') } else { views.goto('fail') }
  level.finish({ passed: v.score >= 60 })
}
```

提前通关（现状做不到，改造后可做）：

```
on staff1.noteClicked {
  if (event.midi == q.data.answerMidi) {
    v.score = v.score + q.scoring
    if (v.score >= 30) { level.finish({ passed: true }) }
  }
}
```

**不把 `level.finish` 也做成"图里自行写结果变量"的原因**：结果条/进度落库/云端上报需要一个确定的完成时刻与一次性的副作用；`level.finish` 作为"图可以调用、宿主执行"的原语，是判定与副作用之间最薄的一层契约。

---

## 4. 目标设计（定稿建议）

### 4.1 状态变量契约

| 变量 | 类别 | 类型/初值 | 写 | 读 | 保护 |
| --- | --- | --- | --- | --- | --- |
| `score` | **保留变量**（仍写在 `logic.variables` 里） | 有限数字，默认 0 | 图 assign（作者/模板）；编辑器变量面板只可改初值 | 结算时宿主读；图内可读 | 不可改名/删除（GraphOps/docState/AI 三处）；初值非数字 lint 警告；运行时数值归一 |
| `__row` | **系统变量**（现状） | 数字/原始行号 | 图 assign = 跳题；`question.next` = 下一题；宿主 `loadRow` 写 | 图表达式/行门控/Inspector | 现状保护不变（不可声明/改名/删除；调试/AI 工具禁写，`debugRun.ts:309-311`、`tools-write.ts:648-649`） |

可选：如 D2 决定改名，`__row → row`，`__` 前缀只留给未来纯内部游标（如 `__index`/`__total`，若以后需要）。

`q`：当前表格行；推荐实时 getter（D3）。`event` 保持快照。

### 4.2 事件契约

| 事件 | 负载 | 触发时机 | 说明 |
| --- | --- | --- | --- |
| `level.started` | `{title}` | 进入关卡一次（含重开） | 不变 |
| `view.entered` | `{view}` | 切视图（含初始进入） | 不变 |
| `question.loaded` | `{index,total,row}` | 每次行装载 | 不变；`row`=原始行号 |
| **`question.ended`（新）** | `{index,total,row}` | `question.next` 在**最后一题**被调用时派发一次；跳行/重开清除"已结束"标记后可再次派发 | **不是终态**：只表示"题目序列推到底了"；图在这里做结算/结算前展示/回跳 |
| `level.finished` | `{score:number, passed:boolean}` | `level.finish` 执行后、`onFinished` 之后 | 不变（但 `score` 类型收紧为 number） |

时序：

```
level.started → view.entered → question.loaded(0)
  …（逐题：question.loaded(i)）…
question.next（末题） → question.ended
  └─ 图处理器：branch/level.finish({passed}) → host 执行 finish
       → onFinished({score,passed}) → level.finished{score,passed}
```

`question.ended` 的幂等：同一"结束态"下重复 `question.next` 不重复派发（会话内 `endedFlag`）；`loadRow`（跳行/重开/下一题）清除标记。若图中没有 `question.ended` 处理器，运行时产生一条可定位的 **运行日志错误**（"末题已结束但图中没有 question.ended 处理器——不会结算"），不做静默兜底（D5）。

### 4.3 命令契约

| 命令 | 新语义 |
| --- | --- |
| `question.next()` | 有下一题 → 装载下一题；末题 → 派发 `question.ended`（**不再自动结算**）；结算后 no-op |
| `level.finish({passed?})` | 主动结算。`passed` 缺省 `true`；存在时按布尔真值归一（非布尔→真值转换并记运行日志警告）；**不再读 `flow.pass`**。幂等终态（重复调用忽略） |
| `level.restart()` | 不变（重置变量/组件/行/视图；清 ended 标记） |
| `views.goto(id)` | 不变 |
| `v.__row = N` | 不变（原始行号跳题；越界忽略；同行 no-op；结算后忽略） |

### 4.4 `flow` 字段

- 保留：`order`（sequential/shuffle）、`count`（本局题数）。它们是**出题配置**，由宿主执行（随机/抽题不属于可序列化逻辑，也无法从图读取 `order`）。
- 删除语义：`pass` 废弃，由迁移器编译进图并剥离；schema 永久保留该属性（只增不改不删，保证旧档可装载），类型注释标注废弃。
- 不再新增 `flow.end` 之类的开关：语义由 `migrationRev` 决定，一次迁移后无分叉。

### 4.5 职责边界（宿主 vs 节点图）

| 职责 | 归属 | 理由 |
| --- | --- | --- |
| `flow.order/count`、shuffle/抽题、`order` 数组 | 宿主 | 随机与序列组成是运行时设施；表达式无法读取 |
| 行装载、`question.loaded/ended` 派发、行指针钩子、`pos` 派生 | 宿主 | 性能与状态一致性；图只观察事件 |
| `q` 作用域、`event` 快照、变量存储 | 宿主 | 表达式求值基础设施 |
| 事件队列/预算/调试门控/计时器 | 宿主 | 运行时设施 |
| **每题计分累加、计分口径** | **图** | 作者逻辑；`score` 是唯一计分状态 |
| **结束时机、通过与否** | **图** | 本次统一的核心；`level.finish({passed})` |
| 结算副作用（幂等/停表/结果条/进度落库/云端上报/`level.finished`） | 宿主 | UI 与持久化需要确定的单次终态 |
| 结算后的表现（结果文案、切视图、重玩按钮） | 图（`on level.finished`） | 现状已如此，保持不变 |

### 4.6 不变式（实现与测试必须守住）

1. `score` 是唯一计分状态；结算得分 = `finish` 时刻的 `v.score` 数值（非有限数字 → 0 + 运行日志错误）。
2. `__row` 是当前题目的唯一可写指针；`pos === order.indexOf(v.__row)`；`loadRow` 是唯一装载点。
3. `question.ended` 每个"结束态"只派发一次；`question.next` 在末题不结算；结算后 `question.next`/行指针写入 no-op。
4. `level.finish` 幂等且终态；`level.finished` 只在 `finish` 后派发一次；`score/passed` 与 `onFinished` 完全一致。
5. `flow.pass` 在运行时不再被读取（装载管线保证）；`level.finish` 的 `passed` 完全由图决定。
6. `q` 若采用实时视图：同一处理器内跳行后，后续节点读取的是新行（显式行为，写入文档与测试）。
7. 空表/`count` 边界：`question.next` 在空序列上派发 `question.ended`（`index:0,total:0,row:null`），由图决定是否结算；不崩溃、不静默 finish。
8. 无结算处理器：不静默兜底；lint 警告 + 运行日志错误 + 模板/文档兜底（D5）。

### 4.7 对作者的心智模型（编辑器要教的四句话）

1. **计分**：只在图里写 `v.score`；结算显示的得分就是它。
2. **题目**：`v.__row` 是当前题目行号；点"下一题"用 `question.next`；想跳题就赋 `v.__row`。
3. **结束**：题目推到底会触发 `question.ended`；在这里决定何时 `level.finish({ passed: … })`。
4. **出题顺序**：`flow` 只决定顺序/抽题数，不再决定通关。

### 4.8 为什么不需要改 IR / 脚本投影

`call` 节点的 `args` 本来就是表达式源文本数组，`level.finish` 的参数 `{passed: expr}` 可原样往返（`script.ts` 的 call 生成/解析；`graphEngine.ts:242-247` 求值 `args[0]`）。新增的只是一条事件名常量与一条命令语义，节点种类不变、lint 白名单不变（`LEVEL_METHODS` 仍为 `restart/finish`）。**这意味着本方案的风险集中在宿主语义与迁移，而不是 IR。**

---

## 5. 兼容与迁移设计

### 5.1 语义版本标记：`content.migrationRev`

- 新增可选字段 `content.migrationRev`（integer ≥ 1，schema 增量添加；docs/20 §8 P2 早已建议过该字段名）。
- 缺省视为 `1`（旧语义：flow.pass + 末题自动结算）；`2` = 本方案语义（结算/通关判定入图）。
- `migrateDocToV3` 对 **v1 与 v3 文档都走** `normalizeV3Content`（现状：`migrateDoc.ts:112-117` 的 v3 分支会执行 normalize），新增 `migrateProgressSemantics(content)` 作为 normalize 的最后一步：
  - `migrationRev >= 2` → 直接返回（幂等，不重复加节点）；
  - 否则执行 §5.2 编译 → 写 `migrationRev: 2`。
- 新文档（`blankLevelDoc`）写 `migrationRev: 2`；内置样例重生成后写 `2`。
- 为什么不升 `schemaVersion 4`：schema 根是 `oneOf[V1Level,V3Level]`，升 4 需要新分支 + 所有读写路径/后端 schema 同步，收益仅是语义版本号；而项目已有"内容级规范化 + 只增不改不删"的成熟机制，`migrationRev` 是更小的变更。

### 5.2 迁移算法（`normalizeV3Content` 末尾新增，纯函数、确定性、幂等）

```
migrateProgressSemantics(content):
  if (content.migrationRev ?? 1) >= 2: return content
  logic = content.logic
  passExpr = typeof content.flow?.pass?.expr === 'string' && trim ? trim : null

  # 1) 显式 finish 注入 passed（旧语义：显式 finish 也由 flow.pass 决定 passed）
  for node in logic.nodes where kind=='call' && target=='level' && method=='finish':
     if passExpr != null:
        if node.args == [] or first arg is empty-object/空串:
            node.args = [`{ passed: ${passExpr} }`]
        else if first arg 是对象字面量且不含 passed 键:
            # 安全文本合并（exprBridge.splitTopLevel 的引擎侧镜像已存在）
            插入 `passed: ${passExpr}`
        else:
            # 已含 passed（显式优先）或动态参数：保留原样；
            # 动态参数 + flow.pass 的旧语义无法无损编译 → 记已知限制（§5.6 L4）
  # 2) 末题结束处理器（旧语义：末题 question.next 自动结算）
  if logic.nodes 中不存在 on 事件 == question.ended:
     nodes += [ { on question.ended }, { call level.finish(args = passExpr ? [`{ passed: ${passExpr} }`] : []) } ]
     edges += 连接
     节点 id 用确定性前缀 `mig_q_ended` / `mig_q_ended_finish`（撞名时递增后缀），坐标 = 现有最大 x + 320
  # 3) 删除 flow.pass（order/count 保留；flow 变空则整键删除，保持文档干净）
  # 4) score 补齐：logic.variables.score 缺失 → 置 0
  # 5) 写 content.migrationRev = 2
  return content
```

要点：

- **显式 `level.finish({passed:false})` 保留原样**（旧语义也是强制失败，显式优先）。
- **已有 `on question.ended` 的文档不动**（理论上旧 v3 不存在该事件，但给未来/手工文档留幂等空间）。
- **无 `flow.pass` 的旧档**也会补一个 `on question.ended → level.finish()`：旧语义是"末题自动结算且默认通过"，行为完全一致（synth-lab 即此类）。
- **`flow.pass` 的求值作用域差异**：旧实现 `engine.evaluate` 的 `event={}`（`graphEngine.ts:310-313`）；迁移后在 `question.ended` 处理器里求值，`event` 是 `{index,total,row}`。仅在 pass 表达式引用 `event.*` 时有差异（旧实现必然抛错→未通过；新实现可能得到值）。属极端边角，记录在 §5.6。
- **迁移后的样例与夹具**：8 个 v1 夹具不动；用新的 `migrateDocToV3` 对夹具重跑，把产物写回 8 份 v3 样例（`builtinEquivalence.test.ts:140` 依赖逐字段相等）；tutorial-hello / synth-lab 两份手写 v3 也过一遍迁移后写回。建议加一个 env-gated 的 vitest 生成脚本（项目无 tsx，沿用 `CONSOLE_GATE_REPORT=1 npm test` 的环境变量惯例），避免手抄。

### 5.3 迁移矩阵

| 旧档形态 | 迁移动作 | 新行为等价性 |
| --- | --- | --- |
| `flow.pass` + 仅自动结算（8 数据关、synth 无 pass） | 图内 `level.finish()` 注入 `{passed: <expr>}`（若有）；补 `on question.ended → level.finish` | 完全等价（结算时机从 `question.next` 内改为 `question.ended` 后一个微任务） |
| `flow.pass` + 图内显式 `level.finish()`（tutorial-hello） | 显式 finish 注入 `{passed: <expr>}`；补 ended 处理器（通常不触发，因已结算） | 等价 |
| 无 `flow.pass` + 仅自动结算 | 补 `on question.ended → level.finish()` | 等价（passed=true） |
| 无 `flow.pass` + 显式 `level.finish()` | 补 ended 处理器；显式调用不动 | 等价 |
| 显式 `level.finish({passed:false})` | 保留 | 等价（强制未通过） |
| 显式 finish 带动态/非对象参数 + `flow.pass` | 保留参数；补 ended 处理器用 pass 表达式 | **已知限制**：该显式调用的 passed 从"flow.pass 决定"变为"默认 true"；lint/迁移警告提示改为 `{passed: <表达式>}` |
| 已 `migrationRev>=2` | 原样返回 | 幂等 |

### 5.4 幂等 / 确定性 / 样例重生成

- 幂等：第二次 `migrateDocToV3` 因 `migrationRev>=2` 直接返回；测试用 `expect(migrate(migrate(doc))).toEqual(migrate(doc))`。
- 确定性：同输入逐字段同输出（现有 golden 依赖）；节点 id 派生只依赖文档内容。
- 重生成：`builtinEquivalence` 的 8 组对比必须保持；`migrate.test.ts` 的夹具 lint/on 数/变量键断言、`schemas.test.ts` 的 8 关 schema 断言、`script.test.ts` 的文本往返同步更新。

### 5.5 旧客户端 / 服务端 / 已发布内容

- `schemaVersion` 保持 3；`content.migrationRev` 是新增可选属性 → 旧 bundle 读到带该字段的新文档会因 `additionalProperties:false` 校验失败（单页应用同源部署，刷新即同版本；可接受并记录）。
- 已发布到 hub 的快照是 v3 JSON；游玩/装载走 `loadLevelDoc`（`migrateDocToV3`）→ 自动升级；编辑器保存回写 `migrationRev:2`。
- 进度表 `progress` 结构不变；`score` 为 number 后 `Number()` 强转仍兼容历史数据。
- 服务端 schema 与服务端校验同一份 `schemas/v1/*.json`，随构建部署；`npx wrangler deploy --dry-run` 纳入验收（R41）。

### 5.6 语义差异清单（用户可感知/不可感知）

| 差异 | 类型 | 处置 |
| --- | --- | --- |
| 末题结算从"`question.next` 内同步"变为"`question.ended` 派发后一个微任务" | 不可感知（结果条/事件顺序在 flush 后一致） | 测试覆盖时序 |
| `pass` 表达式引用 `event.*` 的行为变化 | 极端边角 | 文档记录；编译时保留原文 |
| `pass` 表达式在结算时可能抛错（如引用未装载的 `q.*`）：旧实现降级为"未通过并照常结算"，新实现会中断该 `call` 节点 → 可能不结算 | 低概率/高影响 | 迁移器对注入的 `passed` 表达式做**静态风险扫描**（含 `q.`/`event.` 引用、除零等字面量）并给出迁移警告；B4 发布前用 10 关全流程兜底 |
| 显式 finish 动态参数 + pass 的旧档 | 已知限制 | 迁移警告 + lint 提示改写 |
| `score` 非数字 → 结算 0 + 日志错误（旧：原样显示/强转） | 可感知（问题数据） | lint 提前提示；运行时日志可定位 |
| `q` 实时化后"跳行后同链读旧行"不再成立 | 可感知（修正既有坑） | 文档/测试明确；若担心可延后（D3） |
| `question.next` 在末题不再结算 | 可感知（作者需补 ended 处理器） | 迁移自动补；新关 lint/模板/文档兜底 |

---

## 6. 编辑器与 AI 改造方案

### 6.1 FlowEditor → 「出题顺序」

- 保留：顺序下拉、本局题数、摘要（`FlowEditor.tsx:53-64`）。
- 删除：过关条件勾选、ConditionBuilder、`exprErr/exprWarn`、pass 相关 datalist 分支（`FlowEditor.tsx:36-51,104-136`）。
- 新增：说明文案 + 指向图内结算的操作入口（"末题结束/结算在节点图：事件 `question.ended` → 动作 `level.finish`，节点库『末题结算』模板一键添加"）。
- 补 `data-testid`（G3）：`flow-editor`、`flow-order`、`flow-count`、`flow-summary`、`flow-open-graph`。
- CSS：删除 `.flow-pass` 及仅 pass 使用的 `.flow-field-check`/`.flow-editor .cond-b` 规则（G15 死类守卫会验证；`index.css:5017-5085`）；新增说明区样式。
- 测试更新：`editorUi.test.tsx:416-535` 的 7 个用例改为"无 pass 控件 / 顺序与题数仍生效 / 摘要不含 pass / 非法输入不写 doc"。

### 6.2 节点库 / 事件面板 / 模板

- 事件组新增：`question.ended`（"题目结束——末题推进后触发，payload: index/total/row；在这里结算"）（`palette.ts:19-30`）。
- 动作文案更新：`question.next`（"末题派发 question.ended，不自动结算"）、`level.finish`（"结算；可传 `{ passed: 表达式 }` 决定通过/未通过；缺省通过"）（`palette.ts:188-192`）。
- 模板：
  - `tpl-score-gate` 升级为「计分 + 门槛结算」：`on question.ended → level.finish({ passed: v.score >= 10 })` + `on level.started → v.score = 0`（保留变量自动声明）。
  - 新增「末题结算（默认通过）」：`on question.ended → level.finish()`，供不需要通关线的关卡一键补齐。
  - `tpl-timeout-guard` 保留，文案说明 `level.finish()` 默认通过、需按条件时改参数。
- 更新 `palette.test.ts:87-135`（模板数量/节点数/变量声明）。

### 6.3 Inspector：`level.finish` 的「通关判定」编辑器

- `methodOptions` 中 `level.finish` 的 doc 改为 `{ passed?: boolean }`（`NodeInspector.tsx:99-102`）。
- `CallNodeEditor` 为 `target==='level' && method==='finish'` 增加特化 `FinishArgsEditor`：
  - 模式：**总是通过**（args `[]`）/ **总是未通过**（`['{ passed: false }']`）/ **按条件**（`['{ passed: <cond> }']`，复用 ConditionBuilder，支持"高级表达式"兜底）。
  - 切换模式时保留已填条件原文；非三种形态的旧参数走"高级"原样展示。
  - `data-testid`：`ginsp-finish-mode-pass/fail/cond`、`ginsp-finish-cond`。
- 通用 `CallArgsEditor` 仍可用于高级参数（`controls.tsx:300+`），保证 JSON 兼容。

### 6.4 变量面板：`score` 保留行

- 顶部固定两行（参照 `__row` 的既有说明行 `VariablesPanel.tsx:39-47`）：
  - `score`（可编辑初值，仅数字；不可改名/删除；tooltip："保留变量：结算得分唯一来源"）。
  - `__row`（只读，现有说明行；文案同步新语义"当前题目行号；赋值即跳题"）。
- `graphOps`：`renameGraphVariable/removeGraphVariable` 对 `score` 抛错；`setGraphVariable('score', v)` 仅允许有限数字（编辑器数字输入天然保证）。
- `docState.renameVariable/removeVariable` 同步守卫（双保险，AI/测试路径也走这里时同样被拦）。

### 6.5 空白模板（`blankLevelDoc`）

- `variables: { score: 0 }`；`migrationRev: 2`；`flow: { order: 'sequential' }`（无 pass）。
- 图：放一个 `comment` 节点作为教学占位（"计分写 v.score；末题结束触发 question.ended，在节点图调用 level.finish 结算"），不预放 `question.ended` 处理器——避免默认处理器抢在作者自建判定之前 finish（若预放，`on` 处理器按节点顺序先执行，作者后加的阈值处理器会被已结算的幂等挡住）。
- 表格：保留 `data`/`scoring` 两列一行（现状），提示"每行一道题"。
- 空模板不再包含死链 `on level:correct → score+10`；新手上手靠节点库模板 + 平台文档（B4）。
- 测试：`docState.test.ts` 的 blank 形状断言、`prompts.test.ts` 的默认表列断言同步。

### 6.6 数据表/工作台提示

- `TableGrid.tsx` 工具条下 FlowEditor 旁增加提示："行 = 题目；判定/计分/结算逻辑在节点图；`question.ended` 是末题结束事件"。
- 编辑器 lint 区展示新增警告（§7），点击可定位节点（沿用现有 lint 展示）。

### 6.7 AI 工具与提示词

| 面 | 改动 |
| --- | --- |
| `edit_flow`（`tools-write.ts:608-627`） | 删除 `pass` 参数与描述；保留 order/count；返回文案更新；未知参数（旧模型仍传 pass）明确拒绝并回喂"通关判定在节点图：写 `level.finish({ passed: … })`" |
| `read_doc`（`tools.ts`） | flow 摘要去掉 pass，增加"结算在节点图"提示 |
| `prompts.ts` | `LIFECYCLE_CATALOG`（:116-119）加 `question.ended`；结构说明（:165）改 `content.flow：出题顺序/抽题数` + "结算与通关判定在 content.logic"; plan 模式工具清单不变；agent 守则增加"末题要结算：on question.ended → level.finish({passed})" |
| `runHarness.ts` | 未结算时报告提示"若题目已推进到末题，检查 question.ended 处理器与 level.finish"；新增"末题已结束但未结算"的识别（基于 session 运行日志错误 + rowsVisited 末位） |
| 调试工具 | `debug_set_var` 继续拒写 `__row`；`debug_read`/`DebugPanel` 事件目录补 `question.ended`；`debug_dispatch` 可注入该事件（用于演示结算） |
| AI 预设（`AiPanel.tsx:394`） | "把过关条件改成 v.score >= 60" → "让末题结束时按 v.score >= 60 判定通过（在节点图加 question.ended → level.finish）" |

### 6.8 锚点 / CSS / 契约

- 新增/修改交互补 `data-testid`（G3），同步 `g3Anchors.test.ts`（FlowEditor 锚点、FinishArgsEditor、模板/事件锚点可沿用动态前缀）。
- CSS 死类清理（G15）与同特异性覆盖（G7）：删除 pass 专用规则；新增说明区规则不要写在会被后置规则覆盖的位置；跑 `npm run check:css-conflicts`。
- 不改文档已锁定的契约类名（`.stage-*`、`.comp-*`、`.tlist-modal` 等）。

---

## 7. 校验、运行时防御与诊断（"不留死路"）

### 7.1 装载/保存 lint（`lintLoadedLevel`）

| 编号 | 检查 | 级别 | 说明 |
| --- | --- | --- | --- |
| L1 | `variables.score` 缺失或初值非有限数字 | 警告（缺失由迁移补齐，实际只会出现非数字） | "保留变量 score 应为数字；结算按 0 处理" |
| L2 | 图里存在 `question.next`，但全图没有任何 `level.finish` 调用，也没有 `question.ended` 处理器 | 警告 | "关卡推到末题也不会结算——加 `on question.ended → level.finish`" |
| L3 | 有 `question.ended` 处理器，但从该入口沿执行边到不了 `level.finish` | 警告 | 链可达性分析（现有 lint 已有边索引，纯函数可实现） |
| L4 | `level.finish` 首个参数不是"对象字面量 / 空参数"，或对象含 `passed` 以外的键 | 警告 | 运行时只消费 `passed`，其余键被忽略 |
| L5 | 文档仍残留 `flow.pass`（规范化后的防御性检查） | 警告 | 正常装载会被迁移剥离；出现即管线异常 |
| F6（旧） | `flow.pass.expr` 语法错误 | **删除** | pass 不再由运行时求值；旧档迁移期间由编译期表达式 lint 覆盖（迁移器会求值/校验语法） |

### 7.2 运行时防御

- `finish`：`score` 非有限数字 → 0 + `onLogicEvent` error（可见于运行日志/调试面板/AI run_level）；`passed` 非布尔 → 真值转换 + error 级提示。
- `question.ended` 无处理器：`GraphEngine` 新增 `hasHandler(event)`（只读索引导出），会话据此产生 error 日志；**不静默 finish**（D5）。
- 空表：`question.next` → `question.ended`（`{index:0,total:0,row:null}`）；不崩溃。
- 结算后：`question.next`/`v.__row` 写入/`level.finish` 全部 no-op（现状保持）。
- 迁移器：无法无损编译的显式 finish 参数 → 不能抛错（会拒载旧档），改为迁移警告通道；若实现成本高，先记录 lint 提示（见 §5.6 已知限制）。

### 7.3 发布/游玩诊断

- 编辑器打开即展示新增 lint（与保存路径同口径，沿用 `lintLoadedLevel` 单一入口 `validate.ts:289-312`）。
- `run_level`（AI/调试）报告明确区分"未结算 / 末题已结束未结算 / 结算"。
- 发布到 hub 的文档若能装载即允许（保持现策略）；lint 警告视为创作者自查项。可在 B4 的发布前清单中补一条人工检查（平台内文档说明）。

---

## 8. 需要拍板的决策（D1–D6）

| 编号 | 决策 | 推荐 | 备选/影响 |
| --- | --- | --- | --- |
| D1 | 末题结束如何交给图 | **新增 `question.ended` 事件；末题不再自动结算；图内显式 `level.finish({passed})`** | 备选：保留自动结算但读一个 `pass` 变量——仍是宿主判定，违背原则；或暴露 `__index/__total` 让图自己 branch——多两个系统变量、每个关卡写更多样板。 |
| D2 | `__row` 是否改名公开为 `v.row` | **本轮保留 `v.__row`**（语义完全满足；避免与旧档用户变量 `row` 撞名、减少 49 处代码/22 处文档改动）；作为可选 B5 独立批次，需迁移器做**词法级安全改写**（跳过字符串字面量）+ 撞名变量重命名策略 | 备选：B1 一并改名（更贴合你的表述，作者侧更自然，`score/row` 对称），但迁移面/风险显著增加。 |
| D3 | `q` 是否从快照升级为实时视图 | **是**（跳行后同链读新行；消除 docs/25 §4 已知坑，使"row 控制当前题目"自洽） | 备选：保持快照 + 文档明确；实现改动更小，但 row 的"完全控制"留一个例外。 |
| D4 | `score` 保护强度 | **保留变量 + 装载期缺失补 0 + 编辑器锁改名/删除（初值可改）+ AI/GraphOps 守卫 + 类型 lint + 运行时数值归一** | 备选：只加 lint 不锁（改名后仍静默 0，不可接受）。 |
| D5 | 无 `question.ended` 处理器/无 `level.finish` 时 | **不静默兜底**：lint 警告 + 运行时错误日志 + 模板/文档引导 + run_level 提示 | 备选：宿主超时后默认 `finish(passed=true)`——违背"结算在图"，且掩盖作者错误，不推荐。 |
| D6 | `flow.pass` schema 处理 | **永久保留属性（deprecated 注释），运行时不再读；迁移剥离内容** | 备选：删 schema 属性——违反"只增不改不删"，旧档装载失败，不可行。 |

另有两个**已替你定的小决策**（如不同意可推翻）：

- 事件名用 `question.ended`（与 `question.loaded` 成对；不新增 `level.ended`，因为语义属于"题目序列"而非"关卡"）。
- `level.finish` 的 `passed` 缺省 `true`（保持"显式 finish 且不写条件 = 通过"的现状；旧 `flow.pass` 缺省也视为通过）。

---

## 9. 分批实施计划

> B1–B3 必须同一发布窗口（否则编辑器/Tool 仍暴露已失效的 `flow.pass`）；B4 是发布门禁。每批结束都跑全量测试 + tsc，批次内不留红。

### B0 · 设计冻结（本轮）

- 产出：本文档 + 决策 D1–D6 拍板。
- 验收：你确认 §8；若有不同选择，在本文档追加修订记录。

### B1 · 核心语义 + 迁移（不可分割，风险最高）

**改动文件**

- `src/engine/graphProgram.ts`：新增 `QUESTION_ENDED_EVENT` 常量；`LEVEL_METHODS`/`QUESTION_METHODS` 的 lint/描述更新（方法本身不变）；`QUESTION_METHODS` 注释改"末题派发 ended"。
- `src/engine/graphEngine.ts`：`runHandler` 的 `q` 改实时 getter（D3）；新增 `hasHandler(event)`；`evaluate` 保持（flow.pass 删除后可保留给未来用或删除调用）。
- `src/engine/level.ts`：`FlowConfig.pass` 标 `@deprecated`；`LevelDoc.content.migrationRev?: number`。
- `src/runtime/levelSession.ts`：`finish` 去 flow.pass、支持双向 passed、score 数值归一；`question.next` 末题改派 `question.ended`；ended 幂等标记；`loadRow/restart` 清除标记；`pos` 派生不变式与注释；无 handler 诊断；`SessionHost` 的 `finished` 类型 `score: number`。
- `src/engine/migrateDoc.ts`：`migrateProgressSemantics`（§5.2）+ 表达式文本安全改写工具（若 D2 改名则也在此）；`normalizeV3Content` 接入；导出给测试。
- `src/library/validate.ts`：删除 F6 pass lint；新增 L1–L5 警告（可与迁移器/图分析共用）。
- `schemas/v1/level.json`：V3 content 增加 `migrationRev`；`Flow.pass` 描述标废弃。
- `src/sample/*.level.json`（10 份）重生成。
- 测试：`levelSession.test.ts`、`migrateDoc.test.ts`、`builtinEquivalence.test.ts`、`tutorial.test.ts`、`validate.test.ts`、`editorPage.test.tsx`（F6 用例）、`runHarness.test.ts`。

**验收**

- 10 个内置关全流程行为不变：结算 `{score,passed}`、`level.finished` 处理器表现、行推进/视图轨迹、进度落库。
- 迁移幂等/确定性测试通过；`builtinEquivalence` 8 组全绿（样例由新迁移器产物重生成）。
- 无 `flow.pass` 的旧档补默认 ended 处理器后可结算；`flow.pass` 档等价。
- 全量测试 + tsc 绿；无预期 console error/warn。

### B2 · 编辑器创作面

**改动文件**

- `src/editor/FlowEditor.tsx`（→ 出题顺序）、`TableGrid.tsx`（提示）、`docState.ts`（blank 模板、score 守卫、`setFlow` 去掉 pass 类型/测试路径）、`graph/palette.ts`（事件/动作/模板）、`graph/NodeInspector.tsx`（finish 判定编辑器）、`graph/controls.tsx`（如抽 `FinishArgsEditor`）、`graph/VariablesPanel.tsx`（score 保留行）、`graph/DebugPanel.tsx`（事件目录）、`ai/AiPanel.tsx`（预设文案）、`index.css`（删 pass 样式、加说明区）。
- 测试：`editorUi.test.tsx`、`editorPage.test.tsx`、`docState.test.ts`、`palette.test.ts`、`variablesPanel.test.tsx`、`graphEditorUi.test.tsx`、`g3Anchors.test.ts`、`g15Css.test.ts`、`g7Css.test.ts`（如涉及）、`aiPanel.test.tsx`（预设文案若断言）。

**验收**

- 编辑器不再出现"过关条件"；`flow` 只编辑顺序/题数。
- 选中 `level.finish` 可三态设置通过判定，生成的 JSON 为 `{passed: <expr>}`。
- 新建空白关：schema/lint 干净；变量面板有锁定的 `score`；节点库可一键加「末题结算」。
- 所有新交互有 `data-testid`；CSS 门禁绿。

### B3 · AI + 校验诊断

**改动文件**

- `src/ai/tools-write.ts`（edit_flow 去 pass、set_variable 保护 score）、`src/ai/tools.ts`（read_doc flow 段）、`src/ai/prompts.ts`（生命周期/结构/守则）、`src/ai/runHarness.ts`（未结算提示 + ended 诊断）、`src/ai/tools-debug.ts`/`graph/debugRun.ts`（事件目录/日志文案）。
- 测试：`toolsWrite.test.ts`、`tools.test.ts`、`prompts.test.ts`、`runHarness.test.ts`、`toolsDebug.test.ts`、`debugRun.test.ts`（如涉及）。

**验收**

- AI 不再生产 `flow.pass`；描述末题结算时能写出正确图。
- `run_level` 对"末题结束但未结算"给出明确诊断。
- 全量测试绿。

### B4 · 文档、门禁与验收

**文档**

- `AGENTS.md`：行指针语义（顺手修正 `level.next` 残留）、score 保留变量、结算契约、`migrationRev`、测试基线更新。
- `docs/02`（flow 语义/运行语义备忘）、`docs/12`（level facade）、`docs/20`（v3 结构/§5.7 v3 短路）、`docs/25`（行指针/§4 边界）、`docs/26`（行数据应用，如涉及 __row 文案）、`docs/27`（scoring）、`docs/28`（AI 工具）、`docs/30`（调试限制）、`docs/37`（运行时 UI 不变，确认）、`docs/50`（本文）、新增 `docs/51-…落地记录`（实现后）。
- 平台内文档 `src/pages/docsContent.tsx`：判定与结算、LevelScript 示例（`level.next` → `question.next`）、flow 章节重写、生命周期事件表补 `question.ended`。
- `docs/32-编辑器新手教程.tex`：推进与过关设置、模板、系统动作、案例；若 PDF 构建链可用则重生成 PDF，否则在 docs/45 外部门禁清单登记"PDF 未重生成"（不得写成闭环）。
- README / docs 索引（如有相关条目）。

**门禁**

- `npm test`（新基线）；`npm run build`；`npm run verify:dist`；`npm run check:css-conflicts`；`node scripts/visual-matrix.mjs`（需 Edge CDP；若环境不可用按 docs/45 登记外部门禁，不得静态替代）；`node scripts/bundle-report.mjs`（更新 docs/49）；`npx wrangler deploy --dry-run`（schema 变更加跑）。
- 浏览器实测重点：10 关游玩（结算/重玩/最终得分）、tutorial 多视图、synth 末行结算、编辑器 FlowEditor/Inspector/模板/空白关、AI 建关 + run_level、调试面板 `question.ended`。

### B5 · 可选（独立批次）：`__row` 公开改名 `row` / 其他命名收口

- 前提：D2 拍板要做；迁移器需词法级安全改写（字符串字面量内不替换）+ 旧档用户变量 `row` 撞名的处理策略（重命名为 `row_2` 并提示，或装载错误要求用户改）。
- 影响面：`ROW_POINTER_VAR` 常量、图/引擎/会话/调试/AI/编辑器/全部样例/文档；测试与文档同步。
- 不阻塞主方案；建议观察一个发布周期后再做。

---

## 10. 测试与验收

### 10.1 新增/更新测试清单（按文件）

| 文件 | 新增/更新 |
| --- | --- |
| `src/runtime/levelSession.test.ts` | 末题 `question.next` → `question.ended`（不结算）；ended 幂等/跳行重置；`level.finish({passed:true/false})`；缺省通过；score 非数字归零 + 日志错误；finished 后 next/跳行 no-op；空表 next；`finish` 后 `level.finished` 只派发一次；**更新**原 flow.pass/自动结算用例 |
| `src/engine/graphEngine.test.ts` | `q` 实时（跳行后同链读新行）；`hasHandler`；无 handler 诊断 |
| `src/engine/migrateDoc.test.ts` | §5.3 矩阵 7 种输入；幂等；确定性；迁移后 lint 干净；v1/v3 双入口 |
| `src/engine/builtinEquivalence.test.ts` | 样例重生成后保持逐字段相等；命令/变量双跑 |
| `src/sample/tutorial.test.ts` | 行为不变（score/finished/最终得分/重开/synth 末行结算），路径改为经 ended 处理器 |
| `src/ai/runHarness.test.ts` | 结算报告；未结算诊断；ended 无处理器诊断 |
| `src/library/validate.test.ts` | 删除 F6 用例；新增 L1–L5 |
| `src/editor/editorUi.test.tsx` | FlowEditor 无 pass/顺序题数仍生效；FinishArgsEditor 三态；模板/事件锚点 |
| `src/editor/docState.test.ts` | blank 模板新形状；blank schema/lint 干净；score 守卫；setFlow 仅 order/count |
| `src/editor/editorPage.test.tsx` | 删除/替换 F6 装载告警用例；新增 L2 装载告警展示 |
| `src/editor/graph/palette.test.ts` | 模板数量/节点/requiredVars；`question.ended` 事件 |
| `src/editor/graph/variablesPanel.test.tsx` | score 行锁定、不可改名/删除 |
| `src/ai/toolsWrite.test.ts` | edit_flow 不再接受 pass；set_variable 拒改 score 名/删除、拒非数字初值 |
| `src/ai/prompts.test.ts` | 生命周期含 ended；结构说明不含 pass；read_doc 输出 |
| `src/test/g3Anchors.test.ts` | 新锚点 |
| CSS 门禁 | g15/g7/themeTokens 同步 |
| `src/test/docsConsistency.test.ts` | 建议新增：AGENTS/文档中的关键契约句（question.ended / 结算在节点图 / `__row` 语义）防回退 |

### 10.2 验收标准（DoD）

1. **用户可感知行为**：10 个内置关从开始到结算的表现与改造前一致（含 `level.finished` 文案/视图/音效、结果条、重玩、进度徽章）；tutorial 多视图流程不变。
2. **新语义**：末题不再自动结算；`question.ended` 是唯一的"题目推到底"信号；`level.finish({passed})` 是唯一通关判定入口；删除/不写 `flow.pass` 的关卡行为可预期。
3. **作者面**：编辑器无 `flow.pass` UI；`level.finish` 有结构化通关判定；变量面板锁定 `score`；新建关有可用的结算模板；lint 能拦住"无结算出口"。
4. **兼容**：旧档（v1/v3、含 flow.pass）装载即迁移且幂等；保存-重载稳定；导入/导出/云盘/内置副本链路不回归；schema 只增不改不删。
5. **质量门禁**：全量测试绿（新基线）、tsc/build/verify:dist/check:css-conflicts 绿、console 门禁绿；视觉矩阵（或按 docs/45 登记外部门禁）无 FAIL；bundle 记录更新。
6. **AI 闭环**：AI 新建/修改关卡时不再产出 `flow.pass`；`run_level` 能验证结算并报告"未结算"原因。

### 10.3 风险与对策

| 风险 | 概率/影响 | 对策 |
| --- | --- | --- |
| 迁移破坏旧档/重复加节点 | 中/高 | `migrationRev` 标记 + §5.3 矩阵测试 + 幂等/确定性测试 + 8 组 golden |
| 旧档动态 finish 参数语义偏差 | 低/中 | 已知限制文档化 + 迁移警告 + B4 检查清单 |
| 发布后作者忘记加结算 → 玩家卡在末题 | 中/中 | lint L2/L3 + 模板 + run_level 提示 + 文档；不静默兜底 |
| 事件时序变化引发 flaky | 低/低 | 测试用现有 flush 模式；浏览器实测 |
| `q` 实时化行为变化 | 低/低 | 显式测试 + docs/25 修订 + 可退回 D3 |
| 样例重生成与 golden 不一致 | 中/中 | env-gated 生成脚本 + 人工 review diff（只应出现迁移节点） |
| 文档/PDF 漂移 | 高/低 | B4 全量同步 + docsConsistency 锁 + pdf 外部门禁登记 |
| CSS/G3/G15 回归 | 中/低 | B2 同批补锚点/清死类；跑门禁 |
| 旧 bundle 缓存读到新文档 | 低/低 | 同源单页刷新；记录为部署注意项 |

---

## 11. 附录

### A. 迁移前后 IR 示例（note-click 的末题结算）

迁移前（节选）：

```jsonc
// flow
{ "order": "sequential", "count": null, "pass": { "expr": "v.score >= 20" } }
// 图里只有 nextBtn.clicked → if (!v.done) question.next() else level.restart()
```

迁移后：

```jsonc
{ "order": "sequential", "count": null }
// 原有链不变；新增：
{ "id": "mig_q_ended", "kind": "on", "event": "question.ended" }
{ "id": "mig_q_ended_finish", "kind": "call", "target": "level", "method": "finish",
  "args": ["{ passed: v.score >= 20 }"] }
// 边：mig_q_ended → mig_q_ended_finish
```

运行路径：末题点"下一题" → `question.next()` → `question.ended` → `level.finish({passed: v.score>=20})` → 宿主结算 → `level.finished` → 原有结果文案/`done` 逻辑。

### B. 迁移前后 IR 示例（tutorial-hello 的显式 finish）

```jsonc
// 迁移前
{ "id": "finish", "kind": "call", "target": "level", "method": "finish", "args": [] }
// 迁移后
{ "id": "finish", "kind": "call", "target": "level", "method": "finish",
  "args": ["{ passed: v.score >= 10 }"] }
```

### C. 现状证据索引

| 主题 | 文件:行 |
| --- | --- |
| `flow.pass` 求值/降级 | `src/runtime/levelSession.ts:334-356`（尤其 339-347） |
| 末题自动结算 | `src/runtime/levelSession.ts:222-228` |
| `level.finish` 仅 false 生效 | `src/runtime/levelSession.ts:233-237,350` |
| `question.next` / 跳行 | `src/runtime/levelSession.ts:195-206,222-228` |
| 行指针镜像/系统变量 | `src/runtime/levelSession.ts:186-192`；`src/engine/graphProgram.ts:57-58,199-229,363-364` |
| `q` 快照 | `src/engine/graphEngine.ts:189`；`docs/25` §4 |
| `level.finish` 参数求值 | `src/engine/graphEngine.ts:242-247` |
| `flow` schema | `schemas/v1/level.json:399-430` |
| 空白模板 | `src/editor/docState.ts:10-49` |
| FlowEditor pass UI | `src/editor/FlowEditor.tsx:36-51,104-136` |
| 图节点库模板/动作 | `src/editor/graph/palette.ts:108-155,188-192,206-221` |
| Inspector 无参数 | `src/editor/graph/NodeInspector.tsx:99-102` |
| 变量面板 | `src/editor/graph/VariablesPanel.tsx:20-21,39-47` |
| 装载/lint | `src/library/validate.ts:245-312` |
| v3 规范化入口 | `src/engine/migrateDoc.ts:112-117,210-232` |
| golden 等价 | `src/engine/builtinEquivalence.test.ts:136-193` |
| 结算/进度 UI | `src/runtime/LevelRunner.tsx:116-137`；`src/pages/LevelPage.tsx:20-29`；`src/library/db.ts:160-175` |
| AI 工具/提示词 | `src/ai/tools-write.ts:608-627`；`src/ai/prompts.ts:116-119,165,203-205` |
| 内嵌文档 | `src/pages/docsContent.tsx:180-193,424-447,533` |
| 文档裁决 | `docs/02` §3.4/§6；`docs/20` §5.7；`docs/25`；`docs/27`；`docs/37` |

### D. 本方案明确不做的事

- 不升 `schemaVersion`，不改信封/`logicVersion`。
- 不移除 `flow` 的 order/count；不做"图内抽题/乱序"。
- 不删除 `level.finish` / `level.restart` / `question.next` 原语；不把结算副作用搬进图。
- 不实现"图里 `row+1` 即下一题"（语义 B 的完整重构）。
- 不引入流程节点/子图等新 IR 能力（另属 docs/20 §1 裁剪一）。
- 不把 `level.finished` 的事件负载改掉（`{score,passed}` 保持不变以兼容样例/AI/调试）。

### E. B1 关键实现草图（伪代码级，供评审/估工）

```ts
// src/runtime/levelSession.ts（关键形态；命名以实际实现为准）
private endedFlag = false

private loadRow(p: number): void {
  this.stopAllTimers()
  this.pos = p
  this.row = this.doc.content.table.rows[this.order[p]] ?? null
  this.engine.vars[ROW_POINTER_VAR] = this.order[p]   // 唯一合法写入点（保持现状）
  this.endedFlag = false                              // 跳行/重开清除"已结束"
  this.host.onRow(p, this.order.length, this.row)
  this.engine.dispatch(QUESTION_LOADED_EVENT, { index: p, total: this.order.length, row: this.order[p] })
}

private advance(): void {                             // 原 question.next 语义
  if (this.finishedFlag) return
  if (this.pos + 1 < this.order.length) { this.loadRow(this.pos + 1); return }
  if (this.endedFlag) return
  this.endedFlag = true
  this.engine.dispatch(QUESTION_ENDED_EVENT, {
    index: this.pos, total: this.order.length, row: this.order[this.pos] ?? null,
  })
}

private finish(passedArg?: boolean): void {           // 原 flow.pass 求值全部删除
  if (this.finishedFlag) return
  this.finishedFlag = true
  const passed = passedArg ?? true
  this.stopAllTimers()
  const score = finiteNumberOr(this.engine.vars.score, 0) // 非有限数字 → 0 + onLogicEvent error
  this.host.onFinished({ score, passed })
  this.engine.dispatch('level.finished', { score, passed })
}

// handleCommand：
//   question.next → this.advance()
//   level.finish  → const b = args 对象且含 passed 键 ? Boolean(args.passed) : undefined
//                    this.finish(b)
```

```ts
// src/engine/graphEngine.ts
// 1) q 实时视图（D3）
const scope: ExprScope = {
  event: payload,
  get q() { return this.host.getQuestion() },   // 跳行后同链读新行
  v: this.vars,
}
// 2) 供会话诊断"末题无处理器"
hasHandler(event: string): boolean { return (this.idx.onsByEvent.get(event)?.length ?? 0) > 0 }
```

```ts
// src/engine/migrateDoc.ts（新增步骤，接入 normalizeV3Content 末尾）
function migrateProgressSemantics(content: LevelDoc['content']): LevelDoc['content'] {
  if ((content.migrationRev ?? 1) >= 2) return content
  // 1) flow.pass → 注入每个显式 level.finish 的 { passed: expr }（空参/空对象/不含 passed 的对象字面量）
  // 2) 追加 on question.ended → level.finish({ passed: expr } | [])（确定性 id：mig_q_ended / mig_q_ended_finish）
  // 3) 删除 flow.pass；4) 补齐 variables.score = 0；5) migrationRev = 2
  return migrated
}
```

---

## 12. 附：本方案的"最小可评审切片"

如果希望先看效果再做完整投入，可以先落地一个**垂直切片**（仍建议按 B1–B3 一次做完再发布）：

1. 运行时 + 迁移器 + schema（B1）——用 10 个样例 + 1 个手工旧档验证迁移等价；
2. 编辑器只做三件事：FlowEditor 去 pass、Inspector 的 finish 判定编辑器、变量面板 score 锁；
3. AI 的 `edit_flow` 去 pass + 提示词更新；
4. 其余（模板、文档、视觉矩阵）按 B2/B4 补齐。

这样评审时可以直接打开编辑器体验"图内结算"，同时用测试证明旧档零回归。
