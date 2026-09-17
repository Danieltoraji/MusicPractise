# 音乐练习 · UGC 平台（预研 + POC）

纯前端 Web 应用：内容层级为 **系列 → 专题 → 关卡 → 题目**，全部层级支持 UGC。
关卡由组件拼装（五线谱/发声/按钮/文本/选择器…），组件间关系与题目判据由统一接口上的
ECA 规则引擎（"简易代码"）描述；节点图编辑器是后续阶段对同一运行时的可视化前端。

## 运行

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # Vitest：引擎单测 + JSON Schema 校验 + 资源库/导入导出
npm run build    # tsc strict + Vite 生产构建
```

- `#/` 首页（关卡库） · `#/library` 资源库（导入/导出/删除/试玩） · `#/level/:id` 运行关卡
- 内置五关 + 入门系列（1 系列 2 专题）首次启动自动入库；支持导入 `.json` 关卡与 `.zip` 系列包、导出自包含 zip
- `#/tuner` 校音器（麦克风→音分） · `#/rhythm` 节奏判定

## 文档

| 文档 | 内容 |
|---|---|
| [docs/01-预研报告.md](docs/01-预研报告.md) | 技术选型对比、架构、风险清单、POC 验证记录 |
| [docs/02-数据结构设计.md](docs/02-数据结构设计.md) | 数据结构规范（人读版）：资源信封、组件契约、逻辑程序、题目模型 |

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
