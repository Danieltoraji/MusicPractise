/**
 * 皮肤本地资产库（docs/35 §3）：独立 Dexie 库 `skin-assets`，不触碰资源库主库的版本链。
 * 图片存 {data: ArrayBuffer, type}、字体存 ArrayBuffer（FontFace 可直接消费，不经 URL、不受 CSP font-src 限制）。
 * 一切仅存本机 IndexedDB——皮肤外观是设备本地偏好，不进云盘/账户体系（docs/35 §0）。
 */

import Dexie from 'dexie'

export interface SkinImage {
  id: string
  data: ArrayBuffer
  type: string
  createdAt: number
}

export interface SkinFont {
  /** FontFace family 名（同时是 prefs.font 槽位引用的名字） */
  name: string
  data: ArrayBuffer
  createdAt: number
}

interface SkinAssetsDb extends Dexie {
  files: Dexie.Table<SkinImage, string>
  fonts: Dexie.Table<SkinFont, string>
}

let dbInstance: SkinAssetsDb | null = null

/** 惰性建库：无 indexedDB 的环境（node 测试）返回 null，调用方降级为空操作 */
function getDb(): SkinAssetsDb | null {
  if (dbInstance) return dbInstance
  if (typeof indexedDB === 'undefined') return null
  const db = new Dexie('skin-assets') as SkinAssetsDb
  db.version(1).stores({
    files: 'id',
    fonts: 'name',
  })
  dbInstance = db
  return db
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 皮肤资产 id：skin_ + 26 位 Crockford Base32（与 library/id.ts 同一程序化生成纪律） */
export function newSkinAssetId(): string {
  let out = ''
  for (let i = 0; i < 26; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return `skin_${out}`
}

// ---------------------------------------------------------------------------
// 图片：压缩入库 + objectURL 缓存
// ---------------------------------------------------------------------------

/** 长边钳制：背景图 1920、水印 1600（水印多为局部图形，更小足够） */
const IMAGE_MAX_EDGE = { bg: 1920, wm: 1600 }

export async function compressImageFile(file: File, kind: 'bg' | 'wm'): Promise<{ data: ArrayBuffer; type: string }> {
  const bitmap = await createImageBitmap(file)
  try {
    const maxEdge = IMAGE_MAX_EDGE[kind]
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前环境不支持图片处理（canvas 不可用）')
    ctx.drawImage(bitmap, 0, 0, w, h)
    // PNG 保留透明通道（水印常带 alpha）；其余压 JPEG 控制体积
    const keepAlpha = file.type === 'image/png'
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, keepAlpha ? 'image/png' : 'image/jpeg', 0.85),
    )
    if (!blob) throw new Error('图片编码失败')
    return { data: await blob.arrayBuffer(), type: blob.type }
  } finally {
    bitmap.close()
  }
}

export async function saveSkinImage(data: ArrayBuffer, type: string): Promise<string> {
  const db = getDb()
  if (!db) throw new Error('本环境不支持 IndexedDB，无法保存图片')
  const id = newSkinAssetId()
  await db.files.put({ id, data, type, createdAt: Date.now() })
  return id
}

export async function getSkinImage(id: string): Promise<SkinImage | undefined> {
  return (await getDb()?.files.get(id)) ?? undefined
}

export async function deleteSkinImage(id: string): Promise<void> {
  const url = urlCache.get(id)
  if (url) URL.revokeObjectURL(url)
  urlCache.delete(id)
  await getDb()?.files.delete(id)
}

/** id → objectURL 缓存（同一 id 反复解析不重复创建；删除时回收） */
const urlCache = new Map<string, string>()

/** 解析图片 id 为可用的 objectURL；资产缺失/环境不支持时返回 undefined（层自动隐藏） */
export async function resolveSkinImageUrl(id: string | null): Promise<string | undefined> {
  if (!id) return undefined
  const cached = urlCache.get(id)
  if (cached) return cached
  const img = await getSkinImage(id).catch(() => undefined)
  if (!img) return undefined
  const url = URL.createObjectURL(new Blob([img.data], { type: img.type }))
  urlCache.set(id, url)
  return url
}

// ---------------------------------------------------------------------------
// 字体：FontFace 注册（ArrayBuffer 直填，不触发网络请求）
// ---------------------------------------------------------------------------

const registeredFonts = new Set<string>()

export async function listSkinFonts(): Promise<SkinFont[]> {
  return (await getDb()?.fonts.toArray()) ?? []
}

export async function saveSkinFont(name: string, data: ArrayBuffer): Promise<void> {
  const db = getDb()
  if (!db) throw new Error('本环境不支持 IndexedDB，无法保存字体')
  await db.fonts.put({ name, data, createdAt: Date.now() })
}

export async function deleteSkinFont(name: string): Promise<void> {
  registeredFonts.delete(name)
  await getDb()?.fonts.delete(name)
}

/** 把库内字体注册进 document.fonts；已注册/环境不支持时跳过（幂等，可在每次应用皮肤时调用） */
export async function ensureSkinFontsLoaded(): Promise<string[]> {
  const fonts = await listSkinFonts()
  const loaded: string[] = []
  for (const f of fonts) {
    if (registeredFonts.has(f.name)) {
      loaded.push(f.name)
      continue
    }
    try {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) break
      const face = new FontFace(f.name, f.data)
      await face.load()
      document.fonts.add(face)
      registeredFonts.add(f.name)
      loaded.push(f.name)
    } catch {
      // 单个字体损坏不阻塞其余字体
    }
  }
  return loaded
}
