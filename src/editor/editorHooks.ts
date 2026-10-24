/**
 * G14（docs/40 / docs/44 R23）：编辑器「JS/CSS/测试双用 hook class」唯一登记处。
 *
 * 这些类名不是纯样式钩子——JS 会用它们查询/截图/聚焦，测试也依赖其行为契约。
 * 改动值 = 改契约：必须同步 CSS 选择器、JS 查询与测试（`src/test/editorHooks.test.ts` 静态守卫）。
 *
 * 约定：新增双用 class 先在此登记并在消费点引用常量，不要再散落裸字符串。
 */
export const EDITOR_HOOKS = {
  /** 编辑器主体（AI 截图选择器的作用域根） */
  editorBody: 'editor-body',
  /** 编辑器画布（AI screenshot:canvas 目标） */
  editorCanvas: 'editor-canvas',
  /** React Flow 节点层（AI screenshot:graph 目标；RF 内部类，升级 RF 时需复核） */
  graphNodes: 'react-flow__nodes',
  /** React Flow 容器（graphNodes 缺失时的回退目标） */
  graphFlow: 'react-flow',
  /** 节点图工具栏切换按钮（测试/样式双用） */
  graphToggle: 'gtoggle',
  /** 列表编辑弹窗外壳（ListEditor 聚焦逻辑查询） */
  tlistModal: 'tlist-modal',
  /** 游玩舞台视口基类（LevelStage 契约） */
  stageViewport: 'stage-viewport',
  /** 游玩舞台画布基类（LevelStage 契约） */
  stageCanvas: 'stage-canvas',
  /** 调试画面画布（AI screenshot:debug 目标） */
  debugStageCanvas: 'gdb-stage-canvas',
} as const

export type EditorHookName = keyof typeof EDITOR_HOOKS
