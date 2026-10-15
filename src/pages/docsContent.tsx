/**
 * 文档页内容（#/docs，docs/35 §4）：结构化 TSX 数据，版式参考 api-docs.deepseek.com。
 * 内容为本项目的真实用户文档：事实以仓库内引擎/编辑器实现为准（组件契约、表达式函数表、
 * 关卡文档 v3 约束等均与 src/engine、src/runtime 同源核对），后续随功能演进维护。
 */
import type { ReactNode } from 'react'
import { ChangelogBody } from './docsChangelog'

export interface DocItem {
  id: string
  title: string
  /** 搜索补充词（标题之外的匹配来源） */
  keywords?: string
  body: ReactNode
}

export interface DocGroup {
  title: string
  items: DocItem[]
}

function Callout({ kind = 'tip', title, children }: { kind?: 'tip' | 'warn'; title: string; children?: ReactNode }) {
  return (
    <div className={`docs-callout docs-callout-${kind}`}>
      <b>{title}</b>
      {children && <p>{children}</p>}
    </div>
  )
}

function Code({ children }: { children: string }) {
  return (
    <pre className="docs-code">
      <code>{children}</code>
    </pre>
  )
}

export const DOC_GROUPS: DocGroup[] = [
  {
    title: '开始',
    items: [
      {
        id: 'about',
        title: '平台简介',
        keywords: 'intro music practise ugc 音乐练习',
        body: (
          <>
            <p>
              音乐练习是一个<strong>音乐互动关卡</strong>的游玩与创作平台：听音记谱、节奏训练、校音练习、乐理选择题……
              关卡由组件（五线谱、选择器、发声器、节奏训练等）和事件规则拼装而成，任何人都可以创作并分享自己的练习。
            </p>
            <h2>它由什么组成</h2>
            <ul>
              <li>
                <strong>游玩</strong>：首页按「专题系列 / 独立关卡」浏览，点开即玩；进度与通关徽章保存在本机资源库。
              </li>
              <li>
                <strong>创作</strong>：一体化编辑器提供舞台、数据表、伪代码、节点图、JSON 五个视图，配套 AI 辅助创作。
              </li>
              <li>
                <strong>管理</strong>：资源库页负责全量文档的导入导出（.json / .zip）、元数据查看与一键试玩。
              </li>
            </ul>
            <Callout title="数据都在哪？">
              所有关卡与进度默认保存在本机浏览器的 IndexedDB 资源库中；注册账户后可自愿上传到云盘同步，两套存储互不干扰。
            </Callout>
          </>
        ),
      },
      {
        id: 'quickstart',
        title: '快速上手（玩家）',
        keywords: 'play 开始 游玩 第一关',
        body: (
          <>
            <p>三步开始第一次练习：</p>
            <ol>
              <li>
                打开<strong>首页</strong>，从「专题系列」或「独立关卡」中选一个关卡卡片；
              </li>
              <li>进入关卡后按界面提示作答——听音点击音符、跟随节拍敲击、或选择正确答案；</li>
              <li>结算区显示过关结果，通关后卡片会挂上绿色「通过」徽章。</li>
            </ol>
            <Callout kind="warn" title="听不到声音？">
              浏览器要求用户先与页面交互才允许发声。如果首次进入关卡没有声音，在页面上点击或按任意键一次即可解锁音频。
            </Callout>
            <h2>接下来</h2>
            <ul>
              <li>想改关卡或自己做一个 → 阅读《创作入门》；</li>
              <li>想把关卡分享给朋友 → 阅读《导入与导出》；</li>
              <li>想调整外观 → 前往「🎨 皮肤」中心。</li>
            </ul>
          </>
        ),
      },
      {
        id: 'nav',
        title: '页面导航',
        keywords: '导航 顶栏 入口',
        body: (
          <>
            <p>顶栏在所有页面可见：</p>
            <table className="docs-table">
              <thead>
                <tr>
                  <th>入口</th>
                  <th>用途</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>首页</td>
                  <td>专题系列与独立关卡的浏览入口</td>
                </tr>
                <tr>
                  <td>资源库</td>
                  <td>全量关卡/系列管理：导入导出、元数据、试玩、AI 新建关卡</td>
                </tr>
                <tr>
                  <td>文档</td>
                  <td>本页：平台使用与创作参考</td>
                </tr>
                <tr>
                  <td>校音器</td>
                  <td>麦克风实时校音工具（独立页）</td>
                </tr>
                <tr>
                  <td>节奏</td>
                  <td>节奏训练独立练习页</td>
                </tr>
                <tr>
                  <td>🎨 皮肤</td>
                  <td>皮肤中心：配色/字体主题与背景图、水印自定义</td>
                </tr>
                <tr>
                  <td>⚙ 设置</td>
                  <td>AI 接入、账户、云盘、主音量</td>
                </tr>
              </tbody>
            </table>
          </>
        ),
      },
    ],
  },
  {
    title: '玩法',
    items: [
      {
        id: 'types',
        title: '关卡与题目形态',
        keywords: '题型 组件 形态',
        body: (
          <>
            <p>
              一个关卡 = <strong>舞台组件</strong> + <strong>数据表</strong>（题目内容）+ <strong>事件规则</strong>（交互逻辑）+
              <strong>flow 推进</strong>（题目顺序）。常见形态：
            </p>
            <ul>
              <li>
                <strong>听音记谱</strong>：发声器播放旋律，在五线谱或键盘上点击作答；
              </li>
              <li>
                <strong>节奏训练</strong>：跟随节拍敲击，按相对起拍的偏差打分；
              </li>
              <li>
                <strong>乐理选择/填空</strong>：选择器或输入框作答，数据表驱动题库；
              </li>
              <li>
                <strong>校音练习</strong>：校音器组件读取麦克风音高，按音分偏差判定。
              </li>
            </ul>
            <p>组件是关卡的最小积木：文本、按钮、选择器、五线谱、发声器、滑块、输入框、指法键盘、节奏训练、校音器、合成器等，见《组件参考》。</p>
          </>
        ),
      },
      {
        id: 'judging',
        title: '判定与结算',
        keywords: '判定 得分 结算 通过',
        body: (
          <>
            <p>判定逻辑完全由关卡作者用「事件 → 条件 → 动作」规则表达，平台不做隐式判分：</p>
            <ul>
              <li>
                组件发出事件（如 <code>choice.chosen</code>、<code>rhythm.tap</code>、<code>tuner.pitch</code>）；
              </li>
              <li>
                规则按条件执行动作：亮出对错（<code>staff.highlight</code> / <code>choice.reveal</code>）、加分、推进下一题；
              </li>
              <li>
                结算通过 <code>level.finished</code> 事件驱动，过关线由 flow 配置决定。
              </li>
            </ul>
            <Code>{`on choice1.chosen { index, value } {
  if (index == v.answer) {
    label1.show('答对了！', 'success')
    v.score = v.score + 1
  } else {
    label1.show('再想想～', 'error')
  }
}`}</Code>
            <Callout title="防刷分">
              每次作答前规则应把分数板归零并配合首层条件拦截，防止连击重复得分；这是官方关卡的通用写法，创作时建议照做。
            </Callout>
          </>
        ),
      },
      {
        id: 'progress',
        title: '进度与系列',
        keywords: '进度 徽章 通关 系列',
        body: (
          <>
            <ul>
              <li>通关的关卡在首页与系列内挂绿色「通过」徽章，进度存本机资源库；</li>
              <li>
                专题系列把同类关卡聚成文件夹树，支持标题全文搜索；未被任何系列引用的关卡归入「未整理」区；
              </li>
              <li>系列浏览页可在缺失关卡处看到虚线占位（作者删除或未导入）。</li>
            </ul>
          </>
        ),
      },
    ],
  },
  {
    title: '创作',
    items: [
      {
        id: 'editor',
        title: '创作入门',
        keywords: 'editor 编辑器 视图 工作台',
        body: (
          <>
            <p>从资源库「AI 新建关卡」或导入现有 .json 进入编辑器。编辑器由两部分组成：</p>
            <h2>五个视图（顶部 Tab）</h2>
            <table className="docs-table">
              <thead>
                <tr>
                  <th>视图</th>
                  <th>做什么</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>舞台</td>
                  <td>拖放/框选组件，摆放 800×470 画布上的题面布局</td>
                </tr>
                <tr>
                  <td>数据表</td>
                  <td>以表格管理题库：每行一道题，每列一个字段</td>
                </tr>
                <tr>
                  <td>伪代码</td>
                  <td>LevelScript 文本编辑逻辑，与节点图互为投影</td>
                </tr>
                <tr>
                  <td>节点图</td>
                  <td>可视化事件-规则-动作流程图（含调试与 AI 试玩）</td>
                </tr>
                <tr>
                  <td>JSON</td>
                  <td>直接查看/编辑关卡文档原文</td>
                </tr>
              </tbody>
            </table>
            <h2>左侧工作台（可拖拽布局）</h2>
            <p>
              组件面板、事件管理器、变量管理、节点属性、AI 助手五个面板可自由显隐、拖拽组合与调宽，布局自动记忆。右上「▶ 试玩」随时验证；
              AI 助手支持 ask / plan / agent 三种模式（见《AI 辅助创作》）。
            </p>
            <Callout title="建议的创作顺序">先在数据表把题目内容填好 → 舞台摆组件 → 节点图/伪代码写规则 → 试玩调判定 → 填过关线。</Callout>
          </>
        ),
      },
      {
        id: 'datatable',
        title: '数据表与题目',
        keywords: '数据表 题库 换题 loadRow',
        body: (
          <>
            <p>
              数据表是题库的中心：<strong>一行 = 一道题</strong>，列类型支持文本、列表（选项组）、JSON（整块乐谱等）与数字。运行时按行刷新组件内容（
              <code>loadRow</code>），无需为每道题复制逻辑。
            </p>
            <ul>
              <li>
                文本列经 <code>label.setText</code> / <code>choice.setOptions</code> 等命令下发到组件；
              </li>
              <li>
                JSON 列可承载整份乐谱，经 <code>staff.setMusic</code> 一次性刷入五线谱；
              </li>
              <li>
                音符串时序已内化：每个音符自带 <code>t</code>（起始拍）与 <code>rest</code>（休止），表格网格直接编辑。
              </li>
            </ul>
            <Callout title="评分">
              题目评分是数值：<code>q.scoring</code> 直接填数字（如 10），规则里累加即可。
            </Callout>
          </>
        ),
      },
      {
        id: 'staff',
        title: '五线谱输入',
        keywords: 'staff 快捷键 音符 输入',
        body: (
          <>
            <p>编辑器的五线谱弹窗里有一条「主输入槽」，复刻打谱软件的操作手感：</p>
            <table className="docs-table">
              <thead>
                <tr>
                  <th>按键</th>
                  <th>作用</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>C – G</td>
                  <td>输入七个基本音级</td>
                </tr>
                <tr>
                  <td>Shift + 字母</td>
                  <td>叠加重音/和弦</td>
                </tr>
                <tr>
                  <td>0</td>
                  <td>休止符</td>
                </tr>
                <tr>
                  <td>1 – 6</td>
                  <td>时值（全/二/四/八/十六/三十二分音符）</td>
                </tr>
                <tr>
                  <td>.</td>
                  <td>附点</td>
                </tr>
                <tr>
                  <td>↑ / ↓</td>
                  <td>升降八度</td>
                </tr>
                <tr>
                  <td>+ / -</td>
                  <td>微调音准（升降半音记号）</td>
                </tr>
                <tr>
                  <td>← / →</td>
                  <td>移动插入点</td>
                </tr>
                <tr>
                  <td>空格</td>
                  <td>即时试音</td>
                </tr>
              </tbody>
            </table>
          </>
        ),
      },
      {
        id: 'graph',
        title: '节点图',
        keywords: 'graph 节点图 流程 可视化',
        body: (
          <>
            <p>
              节点图是逻辑的图形投影：<strong>事件节点</strong>（on …）、<strong>动作节点</strong>（组件命令 / 赋值 / emit / wait）、
              <strong>分支与循环</strong>，节点间以数据边（读变量/读组件查询）与执行边相连。
            </p>
            <ul>
              <li>左侧组件/变量/事件面板拖入节点，属性面板编辑参数；</li>
              <li>与伪代码视图实时同步（同一份 IR 的两个投影），结构性强的内容建议用图，文字性小改动用脚本；</li>
              <li>内置三层校验：Lint 静态检查（悬空引用、类型不兼容）→ 属性面板内联提示 → 运行时宽松降级（不炸会话）；</li>
              <li>调试模式提供断点、单步与可视化游玩画面，AI 试玩共用同一会话。</li>
            </ul>
          </>
        ),
      },
      {
        id: 'script',
        title: 'LevelScript 伪代码',
        keywords: 'script 伪代码 语法',
        body: (
          <>
            <p>LevelScript 是节点图的文本投影（C/JS 风格），语句与节点一一对应，往返恒等：</p>
            <Code>{`on level.started {
  label1.show('听音辨名 · 第 1 题')
  v.score = 0
  sound1.play([{ midi: 60, dur: '4n' }, { midi: 64, t: 1, dur: '4n' }], 90)
}

on choice1.chosen { index, value } {
  if (index == v.answer) {
    v.score = v.score + 1
    label1.show('答对了！', 'success')
  } else if (index >= 0) {
    label1.show('正确答案是 ' + v.answerName, 'error')
  }
  emit 'app:next' {}
}

on app:next {
  wait (300)
}`}</Code>
            <ul>
              <li>
                <code>on 事件名</code> 开启一个处理器；组件事件带负载：<code>on choice1.chosen &#123; index, value &#125;</code>；
              </li>
              <li>
                变量以 <code>v.名字</code> 读写，由左侧变量面板管理（脚本里不声明）；
              </li>
              <li>
                <code>if / else if / else</code>、<code>while (…)</code>、<code>repeat (n)</code> 均可；被多条路径汇入或循环提前跳出的结构请改用节点图编辑；
              </li>
              <li>
                <code>//</code> 注释；<code>emit '事件' &#123;…&#125;</code> 自定义事件；<code>wait (毫秒)</code> 等待。
              </li>
            </ul>
          </>
        ),
      },
      {
        id: 'flow',
        title: 'flow 推进与过关',
        keywords: 'flow 推进 顺序 抽题 过关线',
        body: (
          <>
            <p>
              flow 决定<strong>题目的推进顺序</strong>与<strong>过关条件</strong>：编辑器提供可视化表单（不再手写 JSON）配置：
            </p>
            <ul>
              <li>
                <strong>推进顺序</strong>：顺序过关或抽题（每轮随机抽取 N 题）；
              </li>
              <li>
                <strong>抽题数</strong>：从题库中抽取的题量；
              </li>
              <li>
                <strong>过关线</strong>：达到分数/正确数即触发 <code>level.finished</code> 结算。
              </li>
            </ul>
            <p>
              推进本身极简：关卡靠 <code>level.next</code> 纯推进 + <code>loadRow</code> 刷新行数据，规则里只需要在合适的时机发起下一步。
            </p>
          </>
        ),
      },
    ],
  },
  {
    title: '参考',
    items: [
      {
        id: 'components',
        title: '组件参考',
        keywords: '组件 reference 事件 命令 契约',
        body: (
          <>
            <p>组件契约 = 对外事件（谁触发）+ 命令（可被规则调用）+ 查询方法（assign 右侧读取）。全部内置组件：</p>
            <table className="docs-table">
              <thead>
                <tr>
                  <th>组件</th>
                  <th>事件</th>
                  <th>命令 / 查询</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>文本 label</td>
                  <td>—</td>
                  <td>show、setText</td>
                </tr>
                <tr>
                  <td>按钮 button</td>
                  <td>clicked</td>
                  <td>setEnabled、setText</td>
                </tr>
                <tr>
                  <td>选择器 choice</td>
                  <td>chosen</td>
                  <td>reveal、reset、setOptions</td>
                </tr>
                <tr>
                  <td>五线谱 staff</td>
                  <td>noteClicked</td>
                  <td>highlight、clear、setMusic</td>
                </tr>
                <tr>
                  <td>发声器 sound</td>
                  <td>—</td>
                  <td>play、stop</td>
                </tr>
                <tr>
                  <td>合成器 synth</td>
                  <td>—</td>
                  <td>play、setWave、stop</td>
                </tr>
                <tr>
                  <td>计时器 timer</td>
                  <td>tick</td>
                  <td>start、stop；getCount()</td>
                </tr>
                <tr>
                  <td>滑块 slider</td>
                  <td>changed</td>
                  <td>setValue；getValue()</td>
                </tr>
                <tr>
                  <td>输入框 input</td>
                  <td>submitted</td>
                  <td>setValue、clear；getValue()</td>
                </tr>
                <tr>
                  <td>指法/键盘 fingering</td>
                  <td>keyClicked</td>
                  <td>highlight、clear</td>
                </tr>
                <tr>
                  <td>节奏训练 rhythm</td>
                  <td>tap、roundDone</td>
                  <td>start、stop</td>
                </tr>
                <tr>
                  <td>校音器 tuner</td>
                  <td>pitch</td>
                  <td>start、stop</td>
                </tr>
              </tbody>
            </table>
            <Callout title="生命周期事件">
              除组件事件外还有关卡级事件：<code>level.started</code>（开局）、<code>level.finished</code>（结算）、
              <code>level.restart</code>（重开）。双下划线前缀（如 <code>__tick</code>）为系统内部保留，不承诺给创作使用。
            </Callout>
          </>
        ),
      },
      {
        id: 'expr',
        title: '表达式参考',
        keywords: 'expr 表达式 函数 运算符',
        body: (
          <>
            <p>
              条件与赋值右侧使用沙箱表达式：变量 <code>v.x</code>、字面量（数字/字符串/布尔/数组/对象）、下标 <code>a[0]</code>、
              成员 <code>v.row.name</code>、组件查询 <code>slider1.getValue()</code>；支持 <code>?:</code> 三元。
            </p>
            <h2>运算符</h2>
            <p>
              算术 <code>+ - * / %</code>；比较 <code>== != &lt; &lt;= &gt; &gt;=</code>；逻辑与成员访问沿 C 风格。
            </p>
            <h2>内置函数</h2>
            <table className="docs-table">
              <thead>
                <tr>
                  <th>函数</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>abs / min / max / round / floor / ceil</td>
                  <td>常规数值运算（min/max 可变参）</td>
                </tr>
                <tr>
                  <td>random() / randomInt(lo, hi)</td>
                  <td>随机数 / 闭区间随机整数</td>
                </tr>
                <tr>
                  <td>len(x)</td>
                  <td>数组、字符串或对象的长度/键数</td>
                </tr>
                <tr>
                  <td>now()</td>
                  <td>当前秒（相对关卡时钟）</td>
                </tr>
                <tr>
                  <td>midiToName(m) / nameToMidi(s)</td>
                  <td>MIDI 编号 ↔ 音名</td>
                </tr>
                <tr>
                  <td>cents(freq, midi)</td>
                  <td>实测频率相对目标音高的音分偏差</td>
                </tr>
                <tr>
                  <td>upper(s) / lower(s)</td>
                  <td>大小写转换</td>
                </tr>
                <tr>
                  <td>append(arr, x) / concat(a, b)</td>
                  <td>追加 / 拼接（数组或字符串）</td>
                </tr>
                <tr>
                  <td>contains(hay, x) / join(arr, sep) / slice(x, start, end?)</td>
                  <td>包含判断 / 连接 / 切片（数组与字符串）</td>
                </tr>
                <tr>
                  <td>rhythmScore(taps, grid, tol)</td>
                  <td>节奏判定：实际敲击相对网格的得分（0-1）</td>
                </tr>
              </tbody>
            </table>
          </>
        ),
      },
      {
        id: 'format',
        title: '关卡文档格式',
        keywords: 'format schema json v3 格式',
        body: (
          <>
            <p>关卡文档（LevelDoc v3）是平台的绝对事实源，外层信封固定 <code>schemaVersion: 1</code>，逻辑结构由{' '}
              <code>logic.logicVersion: 2</code> 判别。导入时经 schema 校验与迁移管线（旧档自动升级）。</p>
            <h2>创作侧硬约束</h2>
            <ul>
              <li>所有对象 ID 由 ULID 程序化生成，组件 id 禁止手工复制；</li>
              <li>
                组件实例 id 保留字 <code>&quot;level&quot;</code> 不可用；
              </li>
              <li>
                音符时值 <code>dur</code> 只接受 <code>(1|2|4|8|16|32)n</code> 及附点变体；单条音符串（NoteList）上限 64；
              </li>
              <li>
                规则事件名必须带 <code>.</code> 或 <code>:</code> 分隔符（<code>choice1.chosen</code>、<code>app:tick</code>），消灭死规则；
              </li>
              <li>
                引用版本 <code>Ref.version</code> 须为合法 semver 范围。
              </li>
            </ul>
            <Callout kind="warn" title="旧格式兼容">
              v1/v2 旧档经迁移器自动编译为图结构；无法识别的残缺卡片会以安全提示卡片降级渲染，不会炸掉资源库页面。
            </Callout>
          </>
        ),
      },
      {
        id: 'keys',
        title: '快捷键',
        keywords: '快捷键 keys undo redo',
        body: (
          <>
            <table className="docs-table">
              <thead>
                <tr>
                  <th>场景</th>
                  <th>按键</th>
                  <th>作用</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>编辑器全局</td>
                  <td>Ctrl+Z</td>
                  <td>撤销（手动编辑与 AI 修改同一栈）</td>
                </tr>
                <tr>
                  <td>编辑器全局</td>
                  <td>Ctrl+Shift+Z / Ctrl+Y</td>
                  <td>重做</td>
                </tr>
                <tr>
                  <td>五线谱输入</td>
                  <td>C–G / 0 / 1-6 / . / ↑↓ / +- / ←→ / 空格</td>
                  <td>见《五线谱输入》</td>
                </tr>
                <tr>
                  <td>AI 助手输入框</td>
                  <td>Enter</td>
                  <td>发送（Shift+Enter 换行）</td>
                </tr>
              </tbody>
            </table>
          </>
        ),
      },
    ],
  },
  {
    title: '扩展',
    items: [
      {
        id: 'ai',
        title: 'AI 辅助创作',
        keywords: 'ai agent plan 助手 接入',
        body: (
          <>
            <p>编辑器内置 AI 助手，可解释、生成与修改关卡。接入方式：设置页 → AI 供应商，填 OpenAI 兼容的 Base URL / 模型 / Key。</p>
            <h2>三种工作模式</h2>
            <ul>
              <li>
                <strong>ask</strong>：只问答不动文档；
              </li>
              <li>
                <strong>plan</strong>：产出编号计划清单，逐项执行并打勾，保留草稿可回滚；
              </li>
              <li>
                <strong>agent</strong>：直接应用编辑，强制配合检查点，可一键撤销本轮全部修改。
              </li>
            </ul>
            <Callout kind="warn" title="Key 安全">
              API Key 以明文保存在本机浏览器 localStorage，不会上传服务器；请勿在共享电脑上保存。
            </Callout>
            <p>上下文窗口自动治理：历史消息超限自动截断，长会话也保持稳定；撞到轮数上限时点「▶ 继续」即可接着跑。</p>
          </>
        ),
      },
      {
        id: 'cloud',
        title: '账户与云盘',
        keywords: 'account 登录 云盘 同步 admin',
        body: (
          <>
            <ul>
              <li>设置页「账户」区注册/登录；登录后顶栏显示昵称；</li>
              <li>「云盘」区可把本机关卡上传云端、在其它设备下载；云盘与本地资源库互不干扰；</li>
              <li>管理员账号由初始化脚本播种产生（注册入口永远不会产出管理员），可进入管理后台管理用户与关卡。</li>
            </ul>
            <Callout title="皮肤与外观">
              皮肤选择、背景图、水印、导入的字体都属于<strong>本机偏好</strong>：仅保存在当前浏览器，不随账户云同步。
            </Callout>
          </>
        ),
      },
      {
        id: 'io',
        title: '导入与导出',
        keywords: '导入 导出 json zip 分享',
        body: (
          <>
            <ul>
              <li>
                单关卡导出为 <code>.json</code>；关卡+引用的系列打为自包含 <code>.zip</code> 包，可直接分享；
              </li>
              <li>资源库页支持批量导入，导入报告会列出新增/跳过/失败的条目；</li>
              <li>对「内置种子」关卡的就地修改会自动另存为你的个人副本，不会污染原始库。</li>
            </ul>
          </>
        ),
      },
      {
        id: 'faq',
        title: '常见问题',
        keywords: 'faq 问题 声音 cors 访问',
        body: (
          <>
            <h2>没有声音？</h2>
            <p>浏览器的自动播放策略要求先交互一次：点击页面任意处或按一个键即可解锁。仍无声时检查系统音量与设置页「主音量」。</p>
            <h2>「测试连接」失败？</h2>
            <p>多为该 AI 服务不允许浏览器跨域直连（CORS）。换用允许浏览器直连的服务，或填一个 OpenAI 兼容的代理地址。</p>
            <h2>关卡数据会丢吗？</h2>
            <p>数据存在浏览器的 IndexedDB 里，清除浏览器数据会一并清掉；重要关卡请导出 .json/.zip 备份或上传云盘。</p>
            <h2>背景图 / 水印换电脑后不见了？</h2>
            <p>外观自定义仅存本机（设计如此，不同步云端），换设备需重新设置。</p>
          </>
        ),
      },
      {
        id: 'changelog',
        title: '更新日志',
        keywords: 'changelog 更新 版本 历史 release',
        body: <ChangelogBody />,
      },
    ],
  },
]

export const DOC_FLAT: DocItem[] = DOC_GROUPS.flatMap((g) => g.items)

export function findDoc(id: string): DocItem | undefined {
  return DOC_FLAT.find((d) => d.id === id)
}
