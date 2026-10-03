/**
 * 用户附图（批次8a）：粘贴/上传的图片进对话前的本地处理。
 * 纯浏览器 API（Image/canvas/FileReader），失败一律回落原图——附图不可用不该挡住提问。
 * 图片以 data URL 进入消息与 IndexedDB 持久化，压缩控制单张体积（约百 KB 级）。
 */

/** 单条消息附图上限（防 data URL 撑爆请求体与本地库） */
export const MAX_ATTACH_IMAGES = 4

/** 压缩重采样：最长边与 JPEG 质量（视觉模型输入通常 ≤1024~1568px，再大是浪费） */
const MAX_SIDE = 1280
const JPEG_QUALITY = 0.85

/**
 * 把 data URL 图片重采样为最长边 ≤ maxSide 的 JPEG（白底填充，透明图不糊成黑块）。
 * 无 canvas / 解码失败 / 目标已小于阈值时回落原图。
 */
export async function downscaleImage(dataUrl: string, maxSide = MAX_SIDE): Promise<string> {
  try {
    const img = await loadImage(dataUrl)
    const longest = Math.max(img.naturalWidth, img.naturalHeight)
    if (longest <= maxSide && dataUrl.startsWith('data:image/jpeg')) return dataUrl
    const scale = Math.min(1, maxSide / longest)
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    return out.length > 0 ? out : dataUrl
  } catch {
    return dataUrl
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

/** File/Blob → data URL（FileReader 包装） */
export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsDataURL(file)
  })
}

/** 容量上限追加（同图不重复入列） */
export function appendCapped(list: readonly string[], url: string, cap = MAX_ATTACH_IMAGES): string[] {
  if (list.includes(url)) return [...list]
  if (list.length >= cap) return [...list]
  return [...list, url]
}

/**
 * 从剪贴板提取图片文件（同步纯函数，便于单测）。
 * 输入是类 DataTransfer.items 的最小结构（type + getAsFile）；只认 image/*，文本粘贴返回空数组。
 */
export function imageFilesFromClipboard(
  items: ArrayLike<{ type: string; getAsFile(): File | null }>,
): File[] {
  const out: File[] = []
  for (let i = 0; i < items.length; i++) {
    if (!items[i].type.startsWith('image/')) continue
    const file = items[i].getAsFile()
    if (file) out.push(file)
  }
  return out
}
