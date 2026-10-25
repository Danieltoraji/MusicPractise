#!/usr/bin/env node
/**
 * R38（docs/44）：浏览器视觉矩阵自动化（EXT-1 执行器）。
 *
 * 无 npm 依赖：用已安装的 Edge + CDP（--remote-debugging-port=9222）驱动，
 * 数据来源为 `npm run preview` 的生产构建（默认 http://localhost:4173）。
 *
 * 用法：
 *   1) npm run build && npm run preview -- --port 4173 --strictPort
 *   2) Edge 启动：msedge --headless=new --remote-debugging-port=9222 --user-data-dir=<tmp> --window-size=1440,900
 *   3) node scripts/visual-matrix.mjs [--out=<dir>] [--quick]
 *
 * 输出：截图 + summary.json + README.md（默认 %TEMP%/mp-visual-matrix/<时间戳>）。
 * 说明：只做「可观察证据」采集（DOM/计算样式/控制台/截图），不修改业务代码、不写入应用 localStorage 以外的数据。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PREVIEW = process.env.MATRIX_PREVIEW ?? 'http://localhost:4173'
const CDP = process.env.MATRIX_CDP ?? 'http://127.0.0.1:9222'
const QUICK = process.argv.includes('--quick')
const ONLY = (process.env.MATRIX_ONLY ?? '').split(',').filter(Boolean)
const OUT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--out='))
  if (arg) return arg.slice('--out='.length)
  return join(tmpdir(), 'mp-visual-matrix', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
})()

// 从样例 JSON 取 id（避免手抄 ULID 少位——曾因 27 vs 30 位误判「关卡不存在」）
const TUTORIAL = JSON.parse(readFileSync(new URL('../src/sample/tutorial-hello.level.json', import.meta.url), 'utf8')).id
const SYNTH = JSON.parse(readFileSync(new URL('../src/sample/synth-lab.level.json', import.meta.url), 'utf8')).id

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function prefsFor(skin) {
  return JSON.stringify({
    skinId: skin,
    bg: { id: null, opacity: 1, scope: 'all' },
    wm: { id: null, opacity: 0.5, pos: 'br', fade: 30 },
    font: { ui: null, display: null },
  })
}

class CDPClient {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.handlers = []
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
        else p.resolve(msg.result)
      } else {
        for (const h of this.handlers) h(msg)
      }
    }
  }
  on(fn) {
    this.handlers.push(fn)
  }
  async send(method, params = {}, timeoutMs = 30000) {
    await this.ready
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() {
    this.ws.close()
  }
}

async function newTarget() {
  const res = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })
  if (!res.ok) throw new Error(`创建 CDP target 失败：HTTP ${res.status}`)
  return res.json()
}

async function evaluate(client, expression, { awaitPromise = false } = {}) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  })
  if (r.exceptionDetails) {
    const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
    throw new Error(`页面脚本异常：${text}`)
  }
  return r.result?.value
}

async function waitFor(client, expression, label, timeoutMs = 12000) {
  const start = Date.now()
  let lastErr = null
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evaluate(client, expression)) return true
    } catch (err) {
      lastErr = err // 导航过程中 execution context 被销毁属正常
    }
    await sleep(120)
  }
  throw new Error(`等待超时（${label}）：${expression}${lastErr ? ` / ${lastErr.message}` : ''}`)
}

async function navigate(client, url) {
  await client.send('Page.navigate', { url })
  await waitFor(client, `document.readyState === 'complete'`, 'document.readyState')
  await sleep(250)
}

async function gotoHash(client, hash, label) {
  await evaluate(client, `(() => { const next = ${JSON.stringify(hash)}; if (location.hash === next) return false; location.hash = next; return true })()`)
  await waitFor(
    client,
    `!!(document.querySelector('.page') || document.querySelector('.theater') || document.querySelector('.shell'))`,
    label,
  )
  await sleep(450)
}

async function screenshot(client, file) {
  const r = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  writeFileSync(file, Buffer.from(r.data, 'base64'))
}

function consoleSummary(events) {
  const all = events.slice()
  const expected = all.filter((e) => /\/api\b|ERR_CONNECTION|Failed to load resource|net::ERR/.test(e.text))
  const unexpected = all.filter((e) => !expected.includes(e))
  return { all, expected, unexpected }
}

const METRICS_JS = `(() => {
  const cs = getComputedStyle(document.documentElement)
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const styleOf = (sel, props) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const s = getComputedStyle(el)
    const out = {}
    for (const p of props) out[p] = s[p]
    return out
  }
  const rfCircle = document.querySelector('.react-flow__background pattern circle')
  const mm = document.querySelector('.react-flow__minimap-node')
  return {
    url: location.href,
    title: document.title,
    skin: document.documentElement.dataset.skin ?? null,
    rootBg: cs.getPropertyValue('--bg').trim(),
    rootInk: cs.getPropertyValue('--ink').trim(),
    viewport: { w: innerWidth, h: innerHeight },
    docScroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    bodyTextLen: (document.body.innerText || '').length,
    hasPage: !!document.querySelector('.page'),
    hasTheater: !!document.querySelector('.theater'),
    hasShell: !!document.querySelector('.shell'),
    editorTitle: (() => {
      const el = document.querySelector('[data-testid="editor-title"]')
      if (!el) return null
      const value = 'value' in el ? el.value : ''
      return (value || el.textContent || '').trim() || null
    })(),
    tabs: [...document.querySelectorAll('[data-testid^="editor-tab-"]')].map((b) => b.textContent.trim()),
    layout: {
      palette: rect('.editor-canvas-layout > .palette'),
      canvas: rect('.editor-canvas-layout .editor-canvas'),
      inspector: rect('.inspector'),
      stage: rect('.stage-canvas'),
      stageViewport: rect('.stage-viewport'),
      graphEditor: rect('.graph-editor'),
      modal: rect('[data-testid="modal"]'),
    },
    tokens: {
      uiBg0: cs.getPropertyValue('--ui-bg0').trim(),
      uiLine: cs.getPropertyValue('--ui-line').trim(),
      geLine: cs.getPropertyValue('--ge-line').trim(),
      uiEdge: cs.getPropertyValue('--ui-edge').trim(),
    },
    graphTokens: (() => {
      const ge = document.querySelector('.graph-editor')
      if (!ge) return null
      const gcs = getComputedStyle(ge)
      return {
        uiBg0: gcs.getPropertyValue('--ui-bg0').trim(),
        uiLine: gcs.getPropertyValue('--ui-line').trim(),
        uiEdge: gcs.getPropertyValue('--ui-edge').trim(),
        geLine: gcs.getPropertyValue('--ge-line').trim(),
        geEdge: gcs.getPropertyValue('--ge-edge').trim(),
      }
    })(),
    graph: {
      className: document.querySelector('.graph-editor')?.className ?? null,
      rfBgFill: rfCircle ? (getComputedStyle(rfCircle).fill || rfCircle.getAttribute('fill')) : null,
      rfBgAttr: rfCircle ? rfCircle.getAttribute('fill') : null,
      minimapFill: mm ? (getComputedStyle(mm).fill || mm.getAttribute('fill')) : null,
      minimapAttr: mm ? mm.getAttribute('fill') : null,
    },
    stageIsland: styleOf('.stage-canvas', ['fontFamily', 'backgroundColor', 'color', 'transform']),
    shellStyle: styleOf('.shell', ['backgroundColor', 'color']),
    bodyStyle: styleOf('body', ['backgroundColor', 'color', 'fontFamily']),
  }
})()`

const STEPS = [
  { id: 'P1', label: '首页', route: '#/' },
  { id: 'P2', label: '资源库', route: '#/library' },
  { id: 'P3', label: '游玩舞台', route: `#/level/${TUTORIAL}`, wait: '.stage-canvas' },
  { id: 'P4', label: '节点图页', route: `#/graph/${TUTORIAL}` },
  { id: 'P5', label: '编辑器·画布', route: `#/edit/${SYNTH}`, wait: '[data-testid="editor-tab-canvas"]' },
  {
    id: 'P6',
    label: '编辑器·节点图',
    action: async (client) => {
      await evaluate(client, `document.querySelector('[data-testid="editor-tab-graph"]')?.click()`)
      await waitFor(client, `!!document.querySelector('.graph-editor')`, 'graph editor')
      await waitFor(client, `!!document.querySelector('.react-flow__background')`, 'RF background')
      await sleep(700)
    },
  },
  {
    id: 'P7',
    label: '编辑器·脚本',
    action: async (client) => {
      await evaluate(client, `document.querySelector('[data-testid="editor-tab-script"]')?.click()`)
      await waitFor(client, `!!document.querySelector('.script-tab')`, 'script tab')
      await sleep(500)
    },
  },
  {
    id: 'P8',
    label: '编辑器·弹窗',
    action: async (client) => {
      await evaluate(client, `document.querySelector('[data-testid="editor-tab-table"]')?.click()`)
      await waitFor(client, `!!document.querySelector('[data-testid="tgrid-row-0"]')`, 'table row')
      await sleep(400)
      await evaluate(client, `document.querySelector('[data-testid="tgrid-cell-0-notes"]')?.click()`)
      await waitFor(client, `!!document.querySelector('[data-testid="modal"]')`, 'modal')
      await sleep(350)
    },
    cleanup: async (client) => {
      await evaluate(client, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await sleep(250)
    },
  },
  { id: 'P9', label: '皮肤中心', route: '#/skins', wait: '.skin-cards' },
  { id: 'P10', label: '文档页', route: '#/docs' },
  { id: 'P11', label: '设置页', route: '#/settings' },
  { id: 'P12', label: '校音器', route: '#/tuner' },
  { id: 'P13', label: '节奏训练', route: '#/rhythm' },
  { id: 'P14', label: '云盘', route: '#/cloud' },
  { id: 'P15', label: '关卡库', route: '#/hub' },
  { id: 'P16', label: '管理后台', route: '#/admin' },
]

const COMBOS = [
  { key: 'dream-light', skin: 'dream', theme: 'light', width: 1440, height: 900 },
  { key: 'dream-dark', skin: 'dream', theme: 'dark', width: 1440, height: 900 },
  { key: 'violet-light', skin: 'violet', theme: 'light', width: 1440, height: 900 },
  { key: 'violet-dark', skin: 'violet', theme: 'dark', width: 1440, height: 900 },
  { key: 'liuhua-light', skin: 'liuhua', theme: 'light', width: 1440, height: 900 },
  { key: 'liuhua-dark', skin: 'liuhua', theme: 'dark', width: 1440, height: 900 },
  { key: 'dream-mobile', skin: 'dream', theme: 'light', width: 390, height: 844, mobile: true },
  { key: 'liuhua-mobile', skin: 'liuhua', theme: 'dark', width: 390, height: 844, mobile: true },
]

async function main() {
  mkdirSync(OUT, { recursive: true })
  const target = await newTarget()
  const client = new CDPClient(target.webSocketDebuggerUrl)
  const consoleEvents = []
  client.on((msg) => {
    if (!msg.method) return
    const now = new Date().toISOString()
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      const text = msg.params.args
        .map((a) => (typeof a.value === 'string' ? a.value : a.description ?? a.type ?? ''))
        .join(' ')
        .slice(0, 500)
      consoleEvents.push({ at: now, level: msg.params.type, text })
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      consoleEvents.push({ at: now, level: 'exception', text: (d.exception?.description ?? d.text ?? '').slice(0, 500) })
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry
      if (['error', 'warning'].includes(e.level)) consoleEvents.push({ at: now, level: e.level, text: (e.text ?? '').slice(0, 500) })
    }
  })

  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Log.enable')

  const results = {
    startedAt: new Date().toISOString(),
    preview: PREVIEW,
    gitCommit: (() => {
      try {
        return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
      } catch {
        return 'unknown'
      }
    })(),
    combos: [],
    reducedMotion: null,
    fouc: null,
  }

  // 预置上下文：进入 origin 后写 localStorage；再刷新由各 combo 执行
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await navigate(client, `${PREVIEW}/#/`)
  await waitFor(client, `!!document.querySelector('.shell')`, 'shell', 20000)

  await evaluate(client, `window.__matrixReloadSeq = (window.__matrixReloadSeq || 0) + 1`)

  for (const combo of COMBOS) {
    if (ONLY.length > 0 && !ONLY.includes(combo.key)) continue
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: combo.width,
      height: combo.height,
      deviceScaleFactor: 1,
      mobile: !!combo.mobile,
    })
    await evaluate(
      client,
      `localStorage.setItem('skin.prefs.v1', ${JSON.stringify(prefsFor(combo.skin))}); localStorage.setItem('graph-theme', ${JSON.stringify(combo.theme)}); localStorage.setItem('master-volume', '0')`,
    )
    await client.send('Page.reload')
    // 关键：reload 是异步的，旧文档仍存在——等新文档（__matrixReloadSeq 丢失）+ shell 出现，避免在旧页面上"通过"等待
    await waitFor(
      client,
      `document.readyState === 'complete' && typeof window.__matrixReloadSeq === 'undefined' && !!document.querySelector('.shell')`,
      'combo shell (new document)',
      20000,
    )
    await waitFor(client, `document.documentElement.dataset.skin === ${JSON.stringify(combo.skin)}`, 'skin applied')
    await sleep(500)
    const comboDir = join(OUT, combo.key)
    mkdirSync(comboDir, { recursive: true })
    const comboResult = { ...combo, steps: [] }
    for (const step of STEPS) {
      if (combo.mobile && !['P1', 'P3', 'P5', 'P6', 'P8', 'P9'].includes(step.id)) continue
      const before = consoleEvents.length
      const entry = { id: step.id, label: step.label, pass: true, error: null, screenshot: null }
      try {
        if (step.route) await gotoHash(client, step.route, step.id)
        if (step.wait) await waitFor(client, `!!document.querySelector(${JSON.stringify(step.wait)})`, `${step.id} wait`)
        if (step.action) await step.action(client)
        await sleep(step.settle ?? 450)
        const metrics = await evaluate(client, METRICS_JS)
        entry.metrics = metrics
        // 页面级语义检查：防止"路由存在但内容错误"被截图误判为通过
        if (step.id === 'P3' && /关卡不存在|未找到/.test(await evaluate(client, `document.body.innerText`))) {
          throw new Error('游玩页显示「关卡不存在」')
        }
        if (step.id === 'P5' && !metrics.editorTitle) throw new Error('编辑器标题未加载')
        if (step.id === 'P6' && !metrics.graph.className) throw new Error('节点图未加载')
        if (step.id === 'P8' && !metrics.layout.modal) throw new Error('弹窗未打开')
        if (step.id === 'P9' && !(await evaluate(client, `!!document.querySelector('.skin-cards')`))) {
          throw new Error('皮肤中心未加载')
        }
        const file = join(comboDir, `${step.id}.png`)
        await screenshot(client, file)
        entry.screenshot = file
        const newEvents = consoleEvents.slice(before)
        entry.console = consoleSummary(newEvents)
        if (entry.console.unexpected.length > 0) entry.pass = false
        // 横向溢出检查（视觉矩阵显式项）
        if (metrics.docScroll.w > metrics.viewport.w + 2) {
          entry.overflowX = metrics.docScroll.w - metrics.viewport.w
          entry.pass = false
        }
        if (step.cleanup) await step.cleanup(client)
      } catch (err) {
        entry.pass = false
        entry.error = String(err?.message ?? err)
        try {
          entry.debug = await evaluate(
            client,
            `(async () => {
              const open = (name) => new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
              const db = await open('music-practise-library')
              const tx = db.transaction('resources', 'readonly')
              const all = await new Promise((res, rej) => { const r = tx.objectStore('resources').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
              const rec = await new Promise((res, rej) => { const r = tx.objectStore('resources').get(${JSON.stringify(TUTORIAL)}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
              return { href: location.href, hash: location.hash, text: document.body.innerText.slice(0, 160), recordCount: all.length, record: rec ? { id: rec.id, kind: rec.kind } : null, matchCount: all.filter((x) => x.id === ${JSON.stringify(TUTORIAL)}).length }
            })()`,
            { awaitPromise: true },
          )
        } catch {
          /* debug 失败不掩盖原始错误 */
        }
        try {
          await screenshot(client, join(comboDir, `${step.id}-ERROR.png`))
        } catch {
          /* 截图失败不掩盖原始错误 */
        }
      }
      comboResult.steps.push(entry)
      console.log(`[${combo.key}] ${step.id} ${step.label} => ${entry.pass ? 'OK' : 'FAIL'}${entry.error ? ` (${entry.error})` : ''}`)
    }
    results.combos.push(comboResult)
  }

  // P13 减少动效（真实浏览器验证 G11 CSS 降级）
  try {
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await navigate(client, `${PREVIEW}/#/edit/${SYNTH}`)
    await waitFor(client, `!!document.querySelector('[data-testid="editor-tab-canvas"]')`, 'editor for reduced motion')
    const probe = async () =>
      evaluate(
        client,
        `(() => {
          const el = document.createElement('div')
          el.style.animation = 'mpProbe 1s infinite'
          el.style.transition = 'opacity 1s linear'
          document.body.appendChild(el)
          const s = getComputedStyle(el)
          const out = { animationDuration: s.animationDuration, transitionDuration: s.transitionDuration }
          el.remove()
          return out
        })()`,
      )
    const normal = await probe()
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const reduced = await probe()
    results.reducedMotion = { normal, reduced }
    await client.send('Emulation.setEmulatedMedia', { features: [] })
  } catch (err) {
    results.reducedMotion = { error: String(err?.message ?? err) }
  }

  // G6 首帧预置（FOUC）：在文档创建前注入观察器，记录 skin 写入 / body 出现 / #root 挂载的先后。
  try {
    const foucScript = `(() => {
      window.__fouc = { start: performance.now(), skinAt: null, bodyChildAt: null, rootChildAt: null }
      const mark = () => {
        const now = performance.now()
        if (window.__fouc.skinAt === null && document.documentElement.dataset.skin) window.__fouc.skinAt = now
        if (window.__fouc.bodyChildAt === null && document.body && document.body.children.length > 0) window.__fouc.bodyChildAt = now
        const root = document.getElementById('root')
        if (window.__fouc.rootChildAt === null && root && root.children.length > 0) window.__fouc.rootChildAt = now
      }
      const mo = new MutationObserver(mark)
      const attach = () => {
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] })
        if (document.body) mo.observe(document.body, { childList: true, subtree: false })
        mark()
        const timer = setInterval(() => {
          mark()
          if (window.__fouc.rootChildAt !== null) clearInterval(timer)
        }, 10)
      }
      if (document.documentElement) attach()
      else document.addEventListener('readystatechange', attach, { once: true })
    })()`
    const { identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: foucScript })
    await evaluate(
      client,
      `localStorage.setItem('skin.prefs.v1', ${JSON.stringify(prefsFor('liuhua'))}); localStorage.setItem('graph-theme', 'dark')`,
    )
    await navigate(client, `${PREVIEW}/?fouc=${Date.now()}#/`)
    await waitFor(client, `!!document.querySelector('.shell')`, 'fouc shell', 20000)
    const timeline = await evaluate(client, `window.__fouc ?? null`)
    results.fouc = {
      timeline,
      skinBeforeBody: Boolean(timeline && timeline.skinAt !== null && timeline.bodyChildAt !== null && timeline.skinAt <= timeline.bodyChildAt),
      skinBeforeRoot: Boolean(timeline && timeline.skinAt !== null && timeline.rootChildAt !== null && timeline.skinAt <= timeline.rootChildAt),
      finalSkin: await evaluate(client, `document.documentElement.dataset.skin`),
    }
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
  } catch (err) {
    results.fouc = { error: String(err?.message ?? err) }
  }

  const summaryPath = join(OUT, 'summary.json')
  writeFileSync(summaryPath, JSON.stringify(results, null, 2))
  const fails = results.combos.flatMap((c) => c.steps.filter((s) => !s.pass).map((s) => `${c.key}/${s.id}${s.error ? `: ${s.error}` : ''}`))
  const markdown = [
    `# 视觉矩阵执行结果（R38）`,
    ``,
    `- 时间：${results.startedAt}`,
    `- 提交：${results.gitCommit}`,
    `- 预览：${PREVIEW}（生产构建）`,
    `- 组合：${COMBOS.length}（桌面 6 + 移动 2）`,
    `- 截图目录：${OUT}`,
    `- FAIL 项：${fails.length === 0 ? '无' : fails.length}`,
    ...fails.map((f) => `  - ${f}`),
    ``,
    `| combo | 步骤 | 结果 |`,
    `|---|---|---|`,
    ...results.combos.flatMap((c) => c.steps.map((s) => `| ${c.key} | ${s.id} ${s.label} | ${s.pass ? '✅' : '❌'} |`)),
    ``,
    `## 减少动效探针`,
    '```json',
    JSON.stringify(results.reducedMotion, null, 2),
    '```',
    ``,
    `## FOUC 首帧探针`,
    '```json',
    JSON.stringify(results.fouc, null, 2),
    '```',
  ].join('\n')
  writeFileSync(join(OUT, 'README.md'), markdown)
  console.log(`\nsummary => ${summaryPath}`)
  console.log(`screenshots => ${OUT}`)
  console.log(`FAIL=${fails.length}`)
  client.close()
}

main().catch((err) => {
  console.error('矩阵执行失败：', err)
  process.exit(1)
})

