/**
 * 导入导出：单文档 = JSON；series/topic = refs 闭包打 zip（manifest + resources/*.json）。
 * 导入管线：信封校验 → 包内去重 → refs 闭包检查（缺件整包拒绝）→ 冲突策略（单态：
 * 同 id 同 version 跳过 / 异 version 覆盖更新）→ 报告 added/updated/skipped/rejected/missing。
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { db, getResource, putResource, type ResourceKind } from './db'
import { resolveClosure, type ResourceLite } from './refs'
import { validateEnvelope } from './validate'

// ---------------------------------------------------------------------------
// 打包 / 解包
// ---------------------------------------------------------------------------

export interface BundleManifest {
  schemaVersion: 1
  exportedAt: string
  entries: { file: string; id: string; kind: ResourceKind; version: string }[]
}

export function packBundle(docs: Record<string, unknown>[]): Uint8Array {
  const manifest: BundleManifest = { schemaVersion: 1, exportedAt: new Date().toISOString(), entries: [] }
  const files: Record<string, Uint8Array> = {}
  for (const doc of docs) {
    const d = doc as { id: string; kind: ResourceKind; version: string }
    const file = `resources/${d.kind}-${d.id}.json`
    manifest.entries.push({ file, id: d.id, kind: d.kind, version: d.version })
    files[file] = strToU8(JSON.stringify(doc, null, 2))
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  return zipSync(files)
}

export function unpackBundle(bytes: Uint8Array): { file: string; doc: unknown }[] {
  const unzipped = unzipSync(bytes)
  const out: { file: string; doc: unknown }[] = []
  for (const [path, data] of Object.entries(unzipped)) {
    if (path === 'manifest.json' || !path.startsWith('resources/') || !path.endsWith('.json')) continue
    out.push({ file: path, doc: JSON.parse(strFromU8(data)) })
  }
  if (out.length === 0) throw new Error('zip 中没有 resources/*.json 文档')
  return out
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

export interface ImportEntry {
  file: string
  raw: unknown
}

export interface ImportReport {
  added: string[]
  updated: string[]
  skipped: string[]
  rejected: { file: string; reasons: string[] }[]
  /** 缺件清单；非空时整包被拒绝，未写入任何文档 */
  missing: { id: string; neededBy: string }[]
  aborted: boolean
}

export async function importDocuments(entries: ImportEntry[]): Promise<ImportReport> {
  const report: ImportReport = { added: [], updated: [], skipped: [], rejected: [], missing: [], aborted: false }

  // 1) 信封校验 + 包内去重
  const lites: ResourceLite[] = []
  const seenId = new Map<string, string>()
  for (const entry of entries) {
    const fail = (reasons: string[]) => report.rejected.push({ file: entry.file, reasons })
    if (typeof entry.raw !== 'object' || entry.raw === null || Array.isArray(entry.raw)) {
      fail(['不是 JSON 对象'])
      continue
    }
    const kind = (entry.raw as { kind?: unknown }).kind
    if (typeof kind !== 'string') {
      fail(['缺少 kind 字段'])
      continue
    }
    const v = validateEnvelope(kind, entry.raw)
    if (!v.ok) {
      fail(v.errors)
      continue
    }
    const doc = entry.raw as Record<string, unknown>
    const id = String(doc.id)
    if (seenId.has(id)) {
      fail([`包内 id 重复（与 ${seenId.get(id)} 冲突）`])
      continue
    }
    seenId.set(id, entry.file)
    lites.push({ id, kind: kind as ResourceKind, doc })
  }

  // 2) refs 闭包检查：池 = 包内 + 本机库；根 = 包内文档。缺件 → 整包拒绝
  const libraryRecords = await db.resources.toArray()
  const pool: ResourceLite[] = [
    ...lites,
    ...libraryRecords.map((r) => ({ id: r.id, kind: r.kind, doc: r.doc as Record<string, unknown> })),
  ]
  const closure = resolveClosure(pool, lites.map((l) => l.id))
  if (closure.missing.length > 0) {
    report.missing = closure.missing
    report.aborted = true
    return report
  }

  // 3) 冲突策略（单态）：新增 / 跳过（同 id 同 version）/ 覆盖更新（同 id 异 version）
  const addedDocs: Record<string, unknown>[] = []
  for (const lite of lites) {
    const existing = libraryRecords.find((r) => r.id === lite.id)
    const version = String(lite.doc.version)
    if (existing && existing.version === version) {
      report.skipped.push(lite.id)
      continue
    }
    await putResource(lite.doc as never)
    if (existing) report.updated.push(lite.id)
    else report.added.push(lite.id)
    addedDocs.push(lite.doc)
  }
  void addedDocs
  return report
}

/** 从文件字节导入（.json 单文档或 .zip 包），聚合为一次导入报告 */
export async function importFromFiles(files: { name: string; bytes: Uint8Array }[]): Promise<ImportReport> {
  const entries: ImportEntry[] = []
  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.zip')) {
      for (const e of unpackBundle(f.bytes)) entries.push({ file: `${f.name}/${e.file}`, raw: e.doc })
    } else {
      entries.push({ file: f.name, raw: JSON.parse(strFromU8(f.bytes)) })
    }
  }
  return importDocuments(entries)
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export interface ExportedFile {
  filename: string
  bytes: Uint8Array
  mime: string
}

function slugify(title: string, id: string): string {
  const base = title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
  return `${base || id}_${id.slice(-6)}`
}

export async function exportResource(id: string): Promise<ExportedFile> {
  const rec = await getResource(id)
  if (!rec) throw new Error('资源不存在')
  const slug = slugify(rec.title, rec.id)

  if (rec.kind === 'level' || rec.kind === 'instrument') {
    return {
      filename: `${slug}.json`,
      bytes: strToU8(JSON.stringify(rec.doc, null, 2)),
      mime: 'application/json',
    }
  }

  // series/topic：按 refs 闭包打包（库内缺件则报错——导出必须自包含）
  const all = await db.resources.toArray()
  const pool: ResourceLite[] = all.map((r) => ({ id: r.id, kind: r.kind, doc: r.doc as Record<string, unknown> }))
  const closure = resolveClosure(pool, [id])
  if (closure.missing.length > 0) {
    throw new Error(`库内缺少被引用的资源，无法自包含导出: ${closure.missing.map((m) => m.id).join(', ')}`)
  }
  const docs = [...closure.complete]
    .map((cid) => pool.find((p) => p.id === cid)!.doc)
  return {
    filename: `${slug}.zip`,
    bytes: packBundle(docs),
    mime: 'application/zip',
  }
}

/** 浏览器下载（node 单测不会调用） */
export function downloadBlob(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
