# docs/51 · 关卡运行时 v4 种子设计：流程 main + 题型函数 + 分层数据

> 状态：**设计已确认，进入施工**（2026-10-27 用户确认架构方向并授权自主迭代落地）。
> 施工规划见 [docs/52](52-关卡运行时v4落地施工规划.md)，实现规格冻结见 [docs/53](53-关卡运行时v4规格冻结.md)；实施记录追加到 docs/54、最终验收见 docs/55。
> 取代：[docs/50](50-关卡进程模型统一设计（score-row与结算入图）.md) 的兼容迁移方案——用户已确认**不迁移旧关卡**，v4 采用 clean break。
> 讨论来源：2026-10-26/27 四轮设计讨论（row 的游标/身份/编号、主题/题型/内容分层、题单与 phase/order、调用栈与作用域、事件驱动 vs 命令式）。
> 目标：不是给 v3 打补丁，而是重画内核；**功能对 v3 是超集**，旧关卡可接受重写。

---

## 0. 已确认决策（摘要）

| 编号 | 决策 |
| --- | --- |
| D1 | 运行时从“事件驱动的全局状态机”升级为“带调用栈的异步小程序运行时”。 |
| D2 | **流程调度层 = main**（结构化命令式节点图）；**题型行为层 = 异步函数**（事件驱动/状态机行为图）；**数据层 = 每题型一张关卡实例表**。 |
| D3 | 一道题 = 题型表的一行；题型行为读内容只读、读写题态。每关自带题型实例表，题型行为可跨关复用。 |
| D4 | 题单/manifest 默认自动生成（排除草稿行，按 phase/order/题型顺序/行序）；存在显式题单时**显式优先**。 |
| D5 | `draft` 草稿行不参与自动题单；显式题单可以引用（编辑器警告）。 |
| D6 | 本局牌堆 = 题单 + 发牌配置（order/count/seed/阶段内洗牌），运行时生成；调试可见、seed 可复现。 |
| D7 | **一次一题**：流程调用题型函数并挂起等待返回；不并发、不嵌套。 |
| D8 | 题目执行期间交互归题型，流程挂起；关卡 shell 只做只读展示/运行时按钮；流程可在题目之间与结算后等待 shell 事件。 |
| D9 | 作用域四层：**run / 题型 / 题目实例 / 调用局部+参数**；`score`/`row` 是 run 变量，由流程维护。 |
| D10 | 数据访问：显式参数/返回值优先；flow 拥有 run，题型拥有题型态与实例态，内容只读，跨题只走流程。 |
| D11 | 计分所有权：题型返回 `scoreDelta`（或维护 pending 显示），`v.score` 只由流程写。 |
| D12 | 切题/计分/重试等模式**不做平台枚举策略**；用可展开的预设节点组/参考选项提供。 |
| D13 | 作者逻辑不得出现原始行号/题数；用稳定 id + 派生编号。 |
| D14 | v4 clean break：`schemaVersion: 4`，旧 v3 文档不再可玩；10 个内置样例按新结构重写。 |

**非目标（v4.0）**：不兼容 v3 运行时；不做多题并发；不做题型递归/嵌套调用；不做旧档自动迁移（可后续单独写转换器）；不重做音频/皮肤/云盘等外围能力。

---

## 1. 概念模型

```
                  ┌───────────── 编辑器 ─────────────┐
                  │ 内容表 / 题单 / 流程 / 题型 / 舞台 │
                  └───────────────┬──────────────────┘
                                  ▼
┌───────────────────── 运行时（调用栈） ─────────────────────┐
│  FlowFrame(main)                                            │
│    ├─ shell 组件 / 视图 / 事件等待                          │
│    └─ ask(entry,args) ──► QuestionFrame                     │
│                             ├─ 题型 surface 组件挂载        │
│                             ├─ behavior 事件处理器          │
│                             ├─ q.state / t.* / local        │
│                             └─ return QuestionResult        │
│  返回后：流程写 score / 决定下一步 / finish / restart       │
└─────────────────────────────────────────────────────────────┘
                                  ▲
┌───────────────────── 数据（只读内容 + 运行态） ──────────────┐
│ 每题型一张实例表：行 = 题目；id/draft/phase/order + 内容列  │
│ 题态：按 (type,row) 内存初始化，本局持久，不落库            │
└─────────────────────────────────────────────────────────────┘
```

### 术语

| 术语 | 含义 |
| --- | --- |
| **Level（关卡）** | 一个可玩单元：shell + 题型定义 + 题型实例表 + 题单 + 流程 + 运行配置。 |
| **Flow（流程）** | 关卡顶层 `main` 程序：发牌消费、调用题目、计分、分支/循环、结算、结算后等待。 |
| **QuestionType（题型）** | 一类题的行为包：表现层 surface + 行为图 behavior + 题态 schema + 参数 schema。对外是一个异步函数。 |
| **Instance（题目实例）** | 题型实例表中的一行；有稳定 id；内容只读、题态读写。 |
| **Manifest（题单）** | 本关要执行哪些题目槽位的清单；默认自动生成，可显式覆盖。 |
| **Deck（牌堆）** | 本局实际执行序列 = 题单 + 发牌配置；运行时生成。 |
| **Call/Frame（调用/帧）** | 流程 `ask` 题型时产生的调用栈帧；一局同时最多一个题型帧。 |
| **Preset（预设）** | 可展开的节点组/参考模板（如“首次答对只计一次分”），不是运行时策略开关。 |
| **Shell（外壳）** | 关卡级常驻表现层：视图、HUD、进度、背景、菜单、结算后按钮等。 |
| **Surface（题目区域）** | 题型自带的表现层组件；仅在题型调用期间挂载。 |

### 设计原则

1. **单一调用栈**：流程 main 按显式顺序执行；题目是函数调用；没有跨题事件交错。
2. **显式数据流**：参数、返回值、作用域写权限都是显式的；少用共享可变状态。
3. **稳定身份**：题目有稳定 id；原始行号/题数不进入作者逻辑。
4. **职责分层**：流程管调度/计分/结算；题型管单题交互/判分；数据表管内容。
5. **预设而非策略**：平台只给原语与不变量；模式以可展开节点组提供，作者可改。
6. **一次一题**：同一时刻只有一个题型函数执行；并发由题内计时器/事件表达。
7. **确定性可调试**：manifest/deck、seed、调用栈、返回值和作用域都可观察。

---

## 2. 内容格式 v4（草案）

### 2.1 LevelDoc

```ts
interface LevelDocV4 {
  schemaVersion: 4
  kind: 'level'
  id: string
  version: string
  meta: Meta
  refs?: Ref[]
  content: LevelContentV4
}

interface LevelContentV4 {
  shell: LevelShell                 // 关卡常驻表现层
  types: Record<string, QuestionTypeDef>
  tables: Record<string, QuestionTable>   // key = typeId；每型一张本关实例表
  manifest?: ExplicitManifest       // 可选；缺省自动题单
  run: RunConfig                     // 发牌配置
  flow: FlowProgram                  // 关卡 main
}
```

### 2.2 题型定义

```ts
interface QuestionTypeDef {
  id: string
  name: string
  description?: string
  surface: {
    components: ComponentInstance[]  // 题型本地 id；运行时内部命名空间隔离
  }
  behavior: BehaviorProgram          // 异步函数行为图；含 on start / on 事件 / return
  state?: StateFieldDef[]            // 题目实例作用域 q.state.* 的初始 schema
  typeState?: StateFieldDef[]        // 题型作用域 t.*（本局持久，可选）
  args?: ParamFieldDef[]             // 流程可传参数 schema（可选，供编辑器表单/校验）
}

interface StateFieldDef {
  key: string
  type: 'number' | 'boolean' | 'string' | 'json'
  init: Json
}
interface ParamFieldDef {
  key: string
  type: 'number' | 'boolean' | 'string' | 'json'
  optional?: boolean
  default?: Json
}
```

### 2.3 题型实例表

```ts
interface QuestionTable {
  columns: ColumnDef[]               // 内容 schema（每型不同；替代 v3 单表列）
  rows: QuestionRow[]
}

interface QuestionRow {
  id: string                         // 稳定 id（ULID 或同关唯一短 id）；增删/重排不变
  draft?: boolean                    // 草稿/备用：不参与自动题单
  phase?: number                     // 阶段（默认 1）
  order?: number                     // 阶段内顺序（默认行序）
  [contentKey: string]: Json          // 内容列值（只读）
}
```

### 2.4 题单与发牌

```ts
interface ExplicitManifest {
  entries: ManifestEntry[]
}
interface ManifestEntry {
  type: string
  row: string                        // 行 id
  args?: Json                        // 该槽位传给题型的参数
}

interface RunConfig {
  order?: 'manifest' | 'shuffle'     // default 'manifest'
  count?: number | null              // default null = 全部
  seed?: number | string | null      // 随机种子；null = 每局随机（记录到调试信息）
  shuffleWithinPhase?: boolean       // default true：按 phase 分组、组内洗牌
}
```

### 2.5 表现层与绑定

```ts
interface LevelShell {
  views: ViewDef[]                   // 关卡常驻视图（欢迎页/答题背景/结算页…）
  components: ComponentInstance[]    // view 归属；跨题常驻
  initialView?: string
}

interface ComponentInstance {
  id: string                         // shell 内全局唯一；题型内本地唯一
  type: string
  view?: string                      // shell 组件
  layout?: { x: number; y: number; w: number; h: number }
  props?: Json
  bindings?: Record<string, string>  // 纯只读投影：slot → 表达式；不可写、不可触发逻辑
}
```

- **shell**：关卡常驻；flow 可切换视图、调用 shell 组件命令、等待 shell 事件（题目执行期间除外）。
- **surface**：题型自带；题型调用时挂载、返回时卸载；组件内部状态每次调用重置，`q.state` 不重置。
- **绑定**：纯投影，只读；shell 绑定可用 `v.*`；题型绑定可用 `q.*`/`q.state.*`/`t.*`/`args.*`/`v.*`（只读）。绑定的重新求值时机与与命令的优先级属于 v4.0 原型验证项（见 §7）。
- 内容列与题态分开：`q.*` = 内容只读；`q.state.*` = 题态读写；id/phase/order/draft 属于平台元数据，题型行为只可读 `q.id`（用于显示/调试），phase/order 只属于题单/发牌。

### 2.6 最小示例

```jsonc
{
  "schemaVersion": 4,
  "kind": "level",
  "id": "res_...",
  "version": "1.0.0",
  "meta": { "title": "示例 · 两道听音选择" },
  "content": {
    "shell": {
      "views": [{ "id": "main", "name": "主视图" }],
      "components": [
        { "id": "progressLabel", "type": "label", "view": "main", "layout": { "x": 20, "y": 10, "w": 200, "h": 32 } }
      ]
    },
    "types": {
      "choice-listen": {
        "id": "choice-listen",
        "name": "听音选择",
        "surface": { "components": [ /* choice1, sound1, feedback1, nextBtn1 ... */ ] },
        "state": [{ "key": "answered", "type": "boolean", "init": false },
                  { "key": "pendingScore", "type": "number", "init": 0 }],
        "behavior": { "logicVersion": 3, "kind": "behavior", "nodes": [], "edges": [] }
      }
    },
    "tables": {
      "choice-listen": {
        "columns": [
          { "key": "prompt", "type": "text" },
          { "key": "options", "type": "list" },
          { "key": "answer", "type": "text" },
          { "key": "listenNotes", "type": "notes" },
          { "key": "scoring", "type": "number" }
        ],
        "rows": [
          { "id": "row_01", "prompt": "听一听，这是什么音？", "options": ["Do", "Re", "Mi"], "answer": "Mi", "listenNotes": [{ "midi": 64 }], "scoring": 10 },
          { "id": "row_02", "prompt": "再听一个", "options": ["Sol", "La", "Si"], "answer": "Sol", "listenNotes": [{ "midi": 67 }], "scoring": 10, "draft": true }
        ]
      }
    },
    "run": { "order": "manifest", "count": null, "seed": null },
    "flow": { "logicVersion": 3, "kind": "flow", "nodes": [], "edges": [] }
  }
}
```

> `row_02` 带 `draft: true`：自动题单不会执行它；要执行必须显式题单或取消草稿。

---

## 3. 运行时模型

### 3.1 启动与执行

**启动顺序**

1. 校验 schema/引用。
2. 初始化 run 作用域（`v.score = 0` 等初始值）。
3. 初始化题态：所有题型表所有行按题型 `state` schema 深拷贝初始化；题型态按 `typeState` 初始化。
4. 生成 manifest（显式或自动）。
5. 生成 deck（order/count/seed）。
6. 挂载 shell 初始视图；启动 Flow main（`start` 节点）。

**Flow main**

- 单一入口 `start`，无 `on` 事件处理器；按执行边顺序执行。
- 支持节点：`assign`、`call`（shell 组件命令/查询）、`ask`（调用题型函数并等待返回）、`foreach`（遍历题单/数组）、`branch`、`loop`、`wait`、`waitShell`（等待 shell 事件）、`finish`、`restart`、`comment`。
- 作用域：`v.*`（run，读写）、`local.*`（flow 帧，读写）、`run.*`（只读：`run.questions`、`run.total`、`run.seed`）。
- 流程结束：自然执行完 = 关卡结束；若未调用 `finish` → 未结算错误/lint 警告。
- 结算后：`finish` 之后的流程仍可继续（只允许 shell 操作、`waitShell`、`restart`、`comment`；`ask` 会报错），用于完成结算后的舞台/重玩流程。

**ask（调用题型函数）**

```ts
type AskNode = {
  kind: 'ask'
  target: string        // 表达式：manifest 槽位对象或 { type, row, args? }
  args?: string         // 表达式：与 target.args 合并/覆盖
  resultVar: string     // 结果写入 local.<resultVar>
}
```

调用生命周期：

1. 解析 `(type, row)`；校验类型/行存在；读取参数（`target.args` + `args` 合并）。
2. 创建 QuestionFrame：内容引用、实例态引用、题型态引用、参数、局部作用域。
3. 挂载题型 surface 组件；创建题型组件 store；预载音频（可选）。
4. 向题型 behavior 派发 `start` 事件；执行其 start 链。
5. 等待：题型组件的用户事件、题型计时器、内部 emit 都只路由给当前 behavior；处理器的 `wait` 允许其它事件在等待期间并行（沿用异步事件队列语义）。
6. behavior 的 `return` 结束调用：首个 return 生效；停止本次调用启动的计时器；卸载 surface、清空调用局部变量；结果交给 flow。
7. 异常：behavior 节点错误 → 调用以 `status:'error'` 返回并进 run log；flow 可分支处理。
8. 取消：restart/退出/看门狗超时 → 中止调用，丢弃帧；不产生返回值。
9. 同一实例再次被调用：`q.state` 持久；组件内部状态、调用局部变量重新初始化。

**QuestionResult 协议**

```ts
type QuestionStatus = 'answered' | 'skipped' | 'timeout' | 'aborted' | 'error'
interface QuestionResult {
  status: QuestionStatus      // 缺省视为 'answered'
  correct?: boolean
  scoreDelta?: number         // 有限数字；由流程决定何时加到 v.score
  payload?: Json              // 题型自定义返回数据
  message?: string            // error 时的可读信息
}
```

- `return` 节点的表达式必须是对象字面量/表达式；运行时校验并归一化。
- **scoreDelta 不自动应用**：流程预设负责 `v.score = v.score + result.scoreDelta`；保持“score 由流程维护”。
- 实时分数显示：题型可维护 `q.state.pendingScore`（约定字段，非平台强制），UI 绑定可显示 `v.score + q.state.pendingScore`；流程应用 scoreDelta 后由预设清零。
- 状态/超时/中止由题型自己决定返回；平台只保证一次调用只返回一次。

**waitShell 与结算后**

- `waitShell(event)`：流程在非题目执行期间等待 shell 组件事件（如开始按钮、重玩按钮）。事件名 = `<shellCompId>.<eventName>`。
- 题目执行期间 shell 事件被忽略并记录警告——题目交互归题型。
- `finish({passed})`：记录本局结果（score = 当前 `v.score`，passed 表达式），显示结算条、保存进度；幂等。之后流程可继续做结算后舞台/等待重玩。
- `restart`：重置 run 变量、题态/题型态、牌堆、shell 视图与流程；重新从 start 开始。

### 3.2 作用域

| 作用域 | 名字空间 | 生命周期 | 归属 | 读 | 写 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| run | `v.*` | 一局 | flow | flow RW；behavior/UI RO | flow | score、row、total、lives、flags |
| 题型 | `t.*` | 一局（按题型） | behavior | behavior RW；flow RO；UI RO | behavior | 类型内连击、难度、类型锁 |
| 题目实例 | `q.state.*` | 一局（按 (type,row)） | behavior | behavior RW；flow RO；UI RO | behavior | answered、attempts、pendingScore |
| 调用局部 | `local.*` | 一次调用 | 当前帧 | 当前帧 RW | 当前帧 | 循环索引、结果变量、临时值 |
| 参数 | `args.*` | 一次调用 | 调用方 | behavior RO | — | 流程传入的难度/上下文 |
| 内容 | `q.*` | 文档 | 作者 | behavior/flow/UI RO | — | prompt、options、answer、scoring |
| 运行时 | `run.*` | 一局 | 运行时 | flow/behavior RO | — | questions、total、seed |

规则：

- 显式命名空间，不做隐式同名覆盖；编辑器下拉按作用域分组。
- run 生命周期 = 一局；`restart` 重新初始化。题态/题型态**不跨局持久**。
- `score`/`row`/`total` 是 run 作用域约定变量：`score` 唯一分数账本；`row` 由流程维护用于展示进度；平台在 finish 时读取 score。
- behavior 不能写 run；flow 不能写题态/题型态（通过状态查询只读访问；重置由题型自己处理或显式运行时命令，v4.0 不开放）。
- 调用局部变量不可被绑定/其它帧访问；`args` 只读。

### 3.3 跨层数据访问

| 需求 | 路径 | 规则 |
| --- | --- | --- |
| 流程调度题目 | flow → question | `ask(target,args)` 显式调用；target 来自 manifest 槽位或显式 `(type,row)` |
| 流程传上下文 | flow → behavior | `args` 只读参数；schema 由题型 `args` 声明 |
| 题型读内容 | behavior → 内容 | 隐式当前行 `q.*`，只读 |
| 题型读写题态 | behavior → 实例 | 隐式 `q.state.*`，本局持久 |
| 题型读写题型态 | behavior → 题型 | 隐式 `t.*` |
| 题型看全局 | behavior → run | `v.*` 只读（显示/适配）；不得写 |
| 题型交回结果 | behavior → flow | `return QuestionResult`；scoreDelta/payload |
| 流程读题态 | flow → 实例 | 只读查询 `state(type,row)`（建议内置函数）；用于依赖/解锁/结算 |
| 流程读内容 | flow → 内容 | 只读查询 `row(type,row)`（按需；调度/显示） |
| 跨题引用 | 题型 ↛ 其它题 | 禁止；需要时由流程把数据放进 args/run 变量 |
| 关卡级 UI | flow/运行时 → shell | flow 命令/切换视图；shell 事件仅在流程等待时投递 |
| 题内 UI | behavior → surface | 只能命令自己的题型组件（id 为题型本地 id） |
| UI 显示 | bindings → 各作用域 | 只读投影；不可写、不可触发逻辑 |

**一句话规则**：*参数 + 返回值是主通道；题型不得写 run，不得访问其它题；跨题规则归流程层。*

### 3.4 题单 / 牌堆算法

**为什么需要题单，而不是让流程用分支/循环直接枚举？**

- 分支/循环是**控制流**：解决“遇到结果走哪条路”；不解决“本关有哪些题、跨题型怎么排、每个槽位什么参数”。
- 稳定 id 是**身份**：解决“引用哪一行”；不解决“本关包含哪些行、多少行、什么顺序”。
- 若流程硬编码 `ask({type,row})`：加题/删题/改顺序就要改流程图，回到 v3 的硬编码问题。
- 若流程遍历整张表：无法做子集、跨题型交错、每槽不同参数；且“哪些行属于本关”被表内容隐式决定。
- 题单是“数据 → 流程”的桥：它可以是显式表，也可以由运行时自动生成并只读暴露给流程。流程用 `foreach`/`ask` 消费，不硬编码 id/数量。

**题单 vs 本局牌堆**：设计期组成通常稳定（自动或显式题单）；本局牌堆按 `run` 配置生成，可以每局不同。若关卡组成本身随机（例如从题库抽 N 题），题单由规则在运行时生成——仍是“自动题单”，只是每局不同。

**自动题单**（无显式 manifest）：

```
entries = []
for typeIndex, typeId in level.types order:
  for rowIndex, row in tables[typeId].rows order:
    if row.draft: continue
    entries.push({
      type: typeId, row: row.id,
      phase: row.phase ?? 1,
      order: row.order ?? rowIndex,
      args: undefined
    })
entries.sort(phase asc, order asc, typeIndex asc, rowIndex asc)
```

**显式题单**：按 `entries` 给定顺序；只执行列出的行；`draft` 不影响（引用草稿行编辑器警告）。显式优先于自动题单与 phase/order 排序。

**生成牌堆**：

```
deck = manifest.entries.slice()
if run.order == 'shuffle':
  if run.shuffleWithinPhase: 按 phase 分组、组内 Fisher–Yates、阶段顺序不变
  else: 整体 Fisher–Yates
if run.count != null: deck = deck.slice(0, count)
为每个 deck 项分配 slotIndex（0 起）
```

- 题单/牌堆对 flow 以只读 `run.questions` 暴露（每项含 type/row/slotIndex/phase/order/args）。
- 随机种子：`run.seed` 为 null 时运行时生成并记录 seed；有值时确定性可复现。重开默认重新发牌；调试/AI 可固定 seed。
- 同一行可在显式题单里出现多次（不同 args）；实例态共享（同一 (type,row)），调用局部变量/组件状态每次重置。
- 步骤上限/行数上限沿用平台 schema 限制（v4 schema 重新定义）。

### 3.5 预设，而不是策略

**平台内核只提供**：作用域与读写权限、`ask` 调用协议、返回协议、题单/发牌、shell/生命周期、`finish/restart`、事件路由与调试。**不提供** attemptPolicy/scorePolicy 等运行时枚举。

| 预设层 | 参考选项示例 | 展开后大致内容 |
| --- | --- | --- |
| 题型行为 | 首次答对只计一次分 | `on choice.chosen` 判定对错 → 写 `q.state.answered/scored` → `return {correct:true,scoreDelta:q.scoring}` |
| 题型行为 | 每次答对都计分 | 去掉“只一次”守卫，每次正确都累加 pending/scoreDelta |
| 题型行为 | 答错重试 / 单次作答 | 修改锁题/尝试条件；控制何时 return |
| 题型行为 | 手动下一题 / 答对自动返回 | 返回时机放在“下一题按钮”或“答对即 return” |
| 题型行为 | 限时返回 | timer 节点 + 超时分支 return timeout |
| 题型行为 | 提示 / 反馈 / 连击 | 题态 + 反馈命令组合 |
| 流程 | 顺序遍历题单 → 每题手动推进 → 完成结算 | `foreach(run.questions)` + `ask` + `v.row` 更新 + `finish({passed: v.score >= X})` |
| 流程 | 答对自动下一题 | 题型预设“答对即返回” + 流程顺序遍历 |
| 流程 | 答错重试 N 次 | `ask` 返回后按 result 再 `ask` 同槽位（题态保留） |
| 流程 | 解锁式 / 分支剧情 | 读 run 变量/`state(type,row)`，条件 `ask`/跳过/`waitShell` |
| 流程 | 结算后展示/重玩 | `finish` → shell 视图/音效 → `waitShell` → `restart` |

实现形态：

- v4.0 采用**印章式节点组**：预设插入后展开成普通节点（带注释/分组标记），作者可改；设置面板可重新应用。**不做**“运行时隐藏策略”。
- “参考选项”是编辑器画廊：显示说明、参数（如分值表达式、阈值、重试次数），插入到当前层。
- 内置预设必须有测试；作者改动后的正确性归作者。平台用 lint/调试/无头运行辅助诊断。

### 3.6 零代码友好

零代码 = **同一语义的生成层**，不是隐藏运行时：

1. **关卡模板**：选择“听音选择/节奏跟拍/教程”等模板，自动生成题型定义、实例表列、流程预设、shell。
2. **题型库**：内置题型可直接用；作者只填数据。题型行为可复用，未来可资源化。
3. **数据角色 + 绑定**：题表列有语义角色（题面/选项/答案/分值/音频），题型 surface 用只读绑定自动显示；换内容不用写图。
4. **行为/流程设置**：把常见模式做成表单/预设（计分、重试、导航、结算、结算后），生成可见节点组。
5. **高级模式**：随时展开成节点图/伪代码；可脱离预设修改。
6. **AI**：按层读写（内容/题型/流程），生成同一套 IR。

---

## 4. IR 草案

### 4.1 FlowProgram

```ts
interface FlowProgram {
  logicVersion: 3
  kind: 'flow'
  nodes: FlowNode[]
  edges: GEdge[]
  locals?: string[]        // 声明的 flow 局部变量
}

type FlowNode =
  | { kind: 'start'; id: string; x?: number; y?: number }
  | { kind: 'assign'; id: string; target: string; value: RValue }        // v.* / local.*
  | { kind: 'call'; id: string; target: string; method: string; args: string[] } // shell 组件命令
  | { kind: 'ask'; id: string; target: string; args?: string; resultVar: string }
  | { kind: 'foreach'; id: string; items: string; itemVar: string; indexVar?: string }
  | { kind: 'waitShell'; id: string; event: string }
  | { kind: 'finish'; id: string; passed?: string }
  | { kind: 'restart'; id: string }
  | { kind: 'branch'; id: string; cond: string }
  | { kind: 'loop'; id: string; mode: 'while' | 'repeat'; cond?: string; times?: string }
  | { kind: 'wait'; id: string; ms: string }
  | { kind: 'comment'; id: string; text: string }
```

- `start` 唯一；无 `on` 事件入口。
- `foreach` 的体 = true 出边可达节点，体尾回边到 `foreach`；false 出边 = 迭代完成后继（与现有 loop 结构同构）。
- `ask` 目标表达式可以是 `run.questions[i]` 的槽位对象，也可以是 `{ type: 'choice', row: 'row_01' }`。
- `finish` 之后只允许 shell 命令/`waitShell`/`restart`/`comment`；`ask` 为运行时错误。
- 流程自然结束而未 finish = 未结算（lint 警告 + 运行时错误日志）。

### 4.2 BehaviorProgram

```ts
interface BehaviorProgram {
  logicVersion: 3
  kind: 'behavior'
  nodes: BehaviorNode[]
  edges: GEdge[]
  locals?: string[]        // 题型函数局部变量（每次调用复位）
}

type BehaviorNode =
  | { kind: 'on'; id: string; event: string }        // 'start' | '<localComp>.<event>' | '<timer>.tick' | 内部事件
  | { kind: 'return'; id: string; result: string }   // QuestionResult 表达式
  | { kind: 'assign'; id: string; target: string; value: RValue }   // q.state.* / t.* / local.*
  | { kind: 'call'; id: string; target: string; method: string; args: string[] } // 仅题型 surface 组件
  | { kind: 'emit'; id: string; event: string; payload?: Record<string, string> } // 题型内部事件
  | { kind: 'branch'; id: string; cond: string }
  | { kind: 'loop'; id: string; mode: 'while' | 'repeat'; cond?: string; times?: string }
  | { kind: 'wait'; id: string; ms: string }
  | { kind: 'comment'; id: string; text: string }
```

- 无 `start` 节点；调用开始时派发 `on start`。
- `return` 首个生效；之后事件丢弃、计时器停止。
- 组件 id 是题型本地 id（运行时内部加命名空间）；不能访问 shell 组件或其它题型。
- 不能写 `v.*`；不能 `ask`；不能 finish/restart。
- 表达式作用域：`q.*`（内容 RO）、`q.state.*`（RW）、`q.id`（RO）、`t.*`（RW）、`args.*`（RO）、`local.*`（RW）、`v.*`（RO）、`run.*`（RO）。
- 查询（RValue.call）只能查题型 surface 组件。
- 计时器属于 surface 组件；调用结束停止本次启动的计时器。

---

## 5. 编辑器设计

### 5.1 信息架构

| 区域 | 内容 |
| --- | --- |
| 关卡编辑器 · 内容 | 题型实例表（每型一个 tab）、行编辑（内容列 + id/draft/phase/order）、题单（自动预览/显式编辑）、发牌配置 |
| 关卡编辑器 · 流程 | Flow main 节点图/流程图、ask/foreach/finish、作用域面板、预设画廊、伪代码 |
| 关卡编辑器 · 舞台 | shell 视图与组件、绑定、事件、运行时按钮 |
| 关卡编辑器 · 预览调试 | 游玩画面、调用栈、作用域、题单/牌堆、事件轨迹、返回结果、断点/单步 |
| 题型编辑器 | surface 组件、behavior 图、题态/题型态 schema、args、预设、预览 |
| JSON | 分层 JSON（level/type/table/flow/behavior），应用走同一校验管线 |

- 题型先内嵌在关卡（`types`），后续可升级为可复用题型资源（独立 id/version/refs）。
- 数据表按题型分 tab；列由题型 schema 定义；保留字段自动展示且不可作内容列。
- 题单：默认“自动预览”只读；切“显式”后编辑槽位（引用 type+row id、可选 args）；显式优先。
- 题目执行期间编辑器禁用流程/题型编辑（运行态），与现有 debug 归属纪律一致。

### 5.2 零代码入口

- 新建关卡 → 选择模板（听音选择/节奏/教程/空白）。
- 数据表 tab：填内容；行可标记草稿；phase/order 默认隐藏（高级显示）。
- 设置面板：计分/重试/导航/结算/结算后（生成可见预设节点组）。
- 题型编辑：只有需要自定义时才进入；普通作者只选内置题型。
- “展开为节点”始终可用，避免黑箱。

### 5.3 调试与 AI

- 调试器：调用栈（flow 帧 + 题型帧）、各作用域、当前题单/牌堆、当前题 return 结果、事件轨迹；flow/behavior 两层断点与单步。
- 无头试运行：按脚本注入 shell 事件与题型组件事件，记录每题返回、score、finish；随机 seed 可复现。
- AI 工具：按层读写（内容表/题型/流程/舞台），写入同样走 schema+lint+预检；预设可被 AI 应用。

---

## 6. 内置样例重写

> 全部按 v4 结构重写；旧 v3 JSON 不迁移。目标不是逐字节复刻旧表现，而是**功能超集 + 新架构示范**。

| 旧样例 | 题型 | 数据列（示例） | 流程 | 计分/结算 |
| --- | --- | --- | --- | --- |
| tutorial-hello | `button-step` / `slider-step` / `choice-listen` | 各题型自己的列 | shell 视图 welcome→step1→step2→step3→done；`waitShell` 开始；顺序 `ask` 3 题；`finish(passed:score>=10)`；`waitShell` 重玩 → `restart` | 仅 choice 计 10 分 |
| synth-lab | `synth-demo` | wave/title/desc/notes | 顺序遍历题单，每题点击播放→下一题返回；`finish(passed:true)` | 无分数 |
| note-click | `staff-click` | prompt/listenNotes/answerMidi/rewardChord/wrongBuzz/scoring | 顺序遍历；每题手动下一题返回；`finish(score>=20)` | 首次答对 `scoreDelta=q.scoring` |
| clef-test | `staff-click`（谱号变体） | 同上 + clef | 同 note-click | `score>=30` |
| theory-choice | `choice-listen` | prompt/options/answer/listenNotes/scoring | 顺序遍历；手动下一题；`finish(score>=10)` | 首次答对计分 |
| melody-dictation | `keyboard-melody` | prompt/targetNotes/scoring | 顺序遍历；提交/自动判定返回；`finish(score>=20)` | 首次正确计分 |
| note-spelling | `text-answer` | prompt/answer/aliases/scoring | 顺序遍历；提交返回；`finish(score>=20)` | 首次正确计分 |
| timed-reaction | `choice-timed` | prompt/options/answer/listenNotes/timeMs/scoring | 顺序遍历；题内计时器超时/答对返回；`finish(score>=20)` | 答对计分；超时无 |
| rhythm-follow | `rhythm-tap` | bpm/beats/threshold/scoring | 顺序遍历；题内多轮判定，`pendingScore` 累加；返回结束；`finish(score>=15)` | 多次计分/上限预设 |
| tune-intro | `tuner-target` | targetMidi/tolerance/stableSeconds/scoring | 顺序遍历；题内稳定判定；返回；`finish(score>=20)` | 首次达标计分 |

- 通用流程预设：`顺序遍历题单 · 每题手动推进 · 完成后按 v.score 结算`：`foreach(run.questions) → ask → 应用 scoreDelta → v.row 更新 → finish`。
- 通用题型预设：`首次答对只计一次分`、`答错可重试`、`答对后锁题`、`手动/自动返回`。
- 每个样例补数据变更测试：加一行、删一行、重排行、标记草稿后 rerun，流程图不改。

---

## 7. 实现要点与风险（需原型验证）

### 7.1 运行时/引擎

- 新增异步解释器（保留现有表达式沙箱、组件契约、音频/存储/日志基础设施）。
- 调用栈帧、作用域存储、题态/题型态、manifest/deck、shell+surface 组件挂载、事件路由、watchdog、取消。
- IR 执行器扩展 `start/ask/foreach/waitShell/finish/restart/return`；Flow 与 Behavior 两套 program schema 与 lint。
- 脚本/JSON 投影：Flow 用 `main { … ask(…) … }`，Behavior 用 `on start { } / on comp.event { } / return {…}`。
- 性能：一次一题，surface 挂载/卸载需轻量；绑定/事件路由避免每帧求值；沿用引擎预算。

### 7.2 需要 spike 验证的点

1. **UI 组合**：shell 视图 + 题型 surface 的分层渲染、本地组件 id 命名空间、事件路由、调用结束时卸载/计时器清理。
2. **绑定**：纯只读表达式的求值时机 vs 命令写入的优先级；是否依赖追踪，还是增量重算；文档/26 的旧绑定经验教训。
3. **结算后流程**：`finish` 后 flow 继续 + `waitShell` 的交互边界；结算条与自定义结算页共存。
4. **调用协议**：return 一次性、事件排队、watchdog、error result；`wait` 与 return 的竞态。
5. **题单/发牌**：phase 分组洗牌、count、seed、重复槽位、显式优先与草稿引用。
6. **题型资源化**：内嵌 vs 独立资源；跨关复用与版本/引用。
7. **编辑器工作量**：题型编辑器、流程编辑器、表格/题单、调试器、预设画廊可能比运行时更大。

### 7.3 主要风险

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| 运行时复杂度 | 调用栈/挂起/取消/事件路由是新的核心 | 先 spike 最小闭环，再扩 |
| UI 组合不确定 | shell+surface+绑定是全新组合 | 尽早做视觉/交互原型 |
| 零代码与自由度冲突 | 预设太多难维护，太少难上手 | 预设画廊 + 可展开节点 + 测试 |
| 题型复用/版本 | 跨关共享行为与数据 schema | 先内嵌，接口预留 typeRef/version |
| 旧体系清理 | v3 代码/测试/文档量大 | clean break，分阶段删除，不双轨 |
| 迁移 | 作者旧关卡无法继续 | 已确认不迁移；如需可写一次性转换器 |
| 性能 | 每题挂载/卸载、异步帧 | 基准测试，复用现有 store/effect 通道 |
| AI 工具复杂度 | 分层读写/校验/定位 | 按层工具 + 统一 apply/validate 管线 |

---

## 8. 落地批次（建议）

| 批次 | 内容 | 验收 |
| --- | --- | --- |
| P0 · Spike | 最小 runtime + 1 题型（判定一次）+ 1 flow（遍历/ask/finish）+ 内存表/自动题单 + 无头测试；验证 IR/作用域/返回/取消 | 一个最小关在无头环境可完整跑完；结论回填本文 |
| P1 · 运行时核心 | manifest/deck、四层作用域、shell/surface、waitShell、finish/restart、watchdog、错误、debug hooks | 运行时单测全绿；变更集数据属性测试通过 |
| P2 · 数据与编辑器 | 题型定义/实例表/题单、题型行为编辑器、流程编辑器、舞台、调试器、JSON/伪代码投影 | 能用编辑器从零做 2 个混合题型关；G3 锚点 |
| P3 · 预设与零代码 | 行为/流程预设画廊、模板、绑定、AI 分层工具 | 零代码模板可建关；预设可展开/可测 |
| P4 · 样例与发布 | 10 个样例重写、文档、视觉矩阵、bundle/安全门禁、删除 v3 路径 | 新基线全绿；样例全通；发布检查 |

- 由于 clean break，P0–P4 应作为一个发布周期内的连续工作，避免长期双轨。
- 测试策略：v3 的 1019 项基线随旧代码退役；v4 重建定向测试 + 数据变更属性测试 + 样例 golden + 浏览器视觉矩阵。

---

## 9. 与 docs/50 的关系 / 明确放弃项

- docs/50 的 `migrationRev`、`flow.pass` 编译、旧 v3 兼容全部**不再执行**。
- v4 不保留：
  - v3 单数据表 + `v.__row` 原始行号语义；
  - `flow`（order/count/pass 三合一）；
  - `question.next` 伪实例；
  - 全局事件处理器式的关卡逻辑；
  - v3 的 `level.finished` 后置事件处理（由 flow 的结算后流程替代）。
- v4 保留并升级：表达式沙箱、组件契约、音频/存储、资源库/云盘/hub、编辑器基础（撤销/AI/校验）、调试/视觉门禁等外围能力。

---

## 10. 附：一句话总览

> **关卡 = 一个 flow main；题 = 一个题型函数的一次调用；题库 = 每型一张关卡实例表；题单 = 本关要跑的槽位清单（默认自动生成，显式优先）；跑题 = 一次一题，main 调函数并等返回值；分数/游标由 main 维护；模式是预设，不是平台策略；编号靠派生，不靠硬编码。**
