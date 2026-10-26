/**
 * W10 浏览器验收（CDP，v4）：模板建关 → 保存 → 加一行数据（流程图零修改）→ 再保存
 * → AI 无 Key 引导 → 预览调试启动 → 内置关完整游玩至结算 + 重玩。
 * 用法：先 `npm run build && npm run preview -- --port 4173`，再启动 Edge Headless + CDP 9222，
 * 然后 MATRIX_BASE=http://localhost:4173 node scripts/acceptance-v4.mjs。
 * 证据（截图+summary.json）写到 %TEMP%/mp-visual-matrix/w10-accept-<时间戳>；只读写浏览器 IndexedDB，不改服务端。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.env.MATRIX_BASE ?? 'http://localhost:4173'
const CDP = 'http://127.0.0.1:9222'
const OUT = join(tmpdir(), 'mp-visual-matrix', `w10-accept-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)
const SYNTH_ID = JSON.parse(readFileSync(new URL('../src/sample/synth-lab.level.json', import.meta.url), 'utf8')).id
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}
const waitFor = async (expression, label, timeout = 20000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return
    await sleep(150)
  }
  throw new Error(`timeout ${label}`)
}
const shot = async (name) => {
  const res = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(res.data, 'base64'))
}
const readRecord = async (levelId) =>
  evaluate(
    `(async () => {
      const open = (name) => new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const db = await open('music-practise-library')
      const rec = await new Promise((res, rej) => { const tx = db.transaction('resources', 'readonly'); const r = tx.objectStore('resources').get(${JSON.stringify(levelId)}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      return rec ? rec.doc : null
    })()`,
    true,
  )

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${JSON.stringify(detail).slice(0, 220)}` : ''}`)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${BASE}/#/edit/new` })
  await waitFor(`document.readyState === 'complete'`, 'load')
  await waitFor(`!!document.querySelector('[data-testid="v4-template-start"]')`, 'template start')
  await shot('A1-template-start')

  await evaluate(`document.querySelector('[data-testid="v4-template-listen-choice"]')?.click()`)
  await waitFor(`!document.querySelector('[data-testid="v4-template-start"]')`, 'template picked')
  await waitFor(`!!document.querySelector('[data-testid^="v4-tgrid-row-"]')`, 'template rows')
  await shot('A2-template-picked')

  const before = {
    rows: await evaluate(`document.querySelectorAll('[data-testid^="v4-tgrid-row-"]').length`),
    title: await evaluate(`document.querySelector('[data-testid="editor-title"]')?.value ?? ''`),
  }
  await evaluate(`document.querySelector('[data-testid="editor-save"]')?.click()`)
  await waitFor(`location.hash.startsWith('#/edit/res_')`, 'saved to real id')
  await waitFor(`(document.querySelector('[data-testid="editor-saved-tip"]')?.textContent ?? '').length > 0`, 'saved tip')
  const levelId = await evaluate(`location.hash.slice('#/edit/'.length)`)
  const saved = await readRecord(levelId)
  check('模板建关保存成功', saved !== null && saved.schemaVersion === 4 && saved.id === levelId, {
    levelId,
    title: saved?.meta?.title,
    rows: saved?.content?.tables?.choice?.rows?.length,
  })
  check('保存文档为普通 IR（flow+types+table）', Boolean(saved?.content?.flow?.nodes?.length && saved?.content?.types?.length), {
    flowNodes: saved?.content?.flow?.nodes?.length,
    types: saved?.content?.types?.length,
  })
  const flowBefore = JSON.stringify(saved?.content?.flow)
  await shot('A3-saved')

  // 加一行数据 → 再保存：流程图必须零修改（A3 核心）
  await evaluate(`document.querySelector('[data-testid="v4-tgrid-add-row"]')?.click()`)
  await sleep(400)
  const rowsAfter = await evaluate(`document.querySelectorAll('[data-testid^="v4-tgrid-row-"]').length`)
  await evaluate(`document.querySelector('[data-testid="editor-save"]')?.click()`)
  await sleep(900)
  const saved2 = await readRecord(levelId)
  const flowAfter = JSON.stringify(saved2?.content?.flow)
  check('加数据行后保存成功且流程图零修改', rowsAfter > before.rows && flowAfter === flowBefore, {
    rowsBefore: before.rows,
    rowsAfter,
    flowUnchanged: flowAfter === flowBefore,
  })
  await shot('A4-row-added')

  // AI 面板：无 Key 时应展示配置引导（ask/agent 可选）
  check(
    'AI 面板按层引导（未配置 Key 提示）',
    await evaluate(`!!document.querySelector('[data-testid="v4-ai"]') && !!document.querySelector('[data-testid="v4-ai-nokey"]')`),
  )

  // 预览调试：启动会话 → run-state → 停止
  await evaluate(`document.querySelector('[data-testid="editor-tab-preview"]')?.click()`)
  await waitFor(`!!document.querySelector('[data-testid="v4-preview-tab"]')`, 'preview tab')
  await evaluate(`document.querySelector('[data-testid="v4-preview-start"]')?.click()`)
  await waitFor(`!!document.querySelector('[data-testid="v4-preview-run-state"]')`, 'preview running')
  await sleep(600)
  await shot('A5-preview-running')
  const runPhase = await evaluate(`document.querySelector('[data-testid="v4-preview-run-state"]')?.getAttribute('data-phase')`)
  check('预览调试可启动会话', runPhase !== null, { runPhase })
  await evaluate(`document.querySelector('[data-testid="v4-preview-stop"]')?.click()`)
  await sleep(300)

  // 十关完整通关的无头证据在 sample/v4 playthrough（132 项）；浏览器侧用 synth-lab 做一次真实全流程 + 重玩
  await send('Page.navigate', { url: `${BASE}/#/level/${SYNTH_ID}` })
  await waitFor(`document.readyState === 'complete'`, 'level load')
  await waitFor(`!!document.querySelector('.stage-canvas')`, 'stage canvas', 20000)
  // synth-lab 每行需手动点「下一音色 ▶」收题（6 行）→ 逐个点击直到结算条出现
  let played = 0
  for (let i = 0; i < 10 && played === 0; i += 1) {
    await evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('下一音色'))?.click()`,
    )
    await sleep(500)
    if (await evaluate(`!!document.querySelector('[data-testid="v4-result"]')`)) played = i + 1
  }
  check('内置关浏览器完整游玩（synth-lab 手动收题 6 行）', played > 0, { clicks: played, result: played > 0 })
  const resultText = await evaluate(`document.querySelector('[data-testid="v4-result"]')?.textContent ?? ''`)
  check('结算条呈现分数/通过状态', resultText.length > 0, { resultText: resultText.slice(0, 120) })
  await shot('A6-playthrough-result')
  await evaluate(`document.querySelector('[data-testid="v4-replay"]')?.click()`)
  await waitFor(`!document.querySelector('[data-testid="v4-result"]')`, 'replay cleared')
  check('结算重玩按钮重置会话', true)
} catch (err) {
  check('验收脚本异常', false, { error: String(err?.message ?? err) })
} finally {
  writeFileSync(
    join(OUT, 'summary.json'),
    JSON.stringify({ base: BASE, results, fail: results.filter((r) => !r.pass).length }, null, 2),
  )
  console.log(`OUT=${OUT}`)
  console.log(`FAIL=${results.filter((r) => !r.pass).length}`)
  ws.close()
}
