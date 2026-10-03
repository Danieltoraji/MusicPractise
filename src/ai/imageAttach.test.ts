import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendCapped, downscaleImage, imageFilesFromClipboard, MAX_ATTACH_IMAGES } from './imageAttach'

describe('appendCapped（待发附图容量控制）', () => {
  it('追加新图；同图去重不重复入列', () => {
    const a = 'data:image/png;base64,AAA'
    const b = 'data:image/png;base64,BBB'
    expect(appendCapped([], a)).toEqual([a])
    expect(appendCapped([a], a)).toEqual([a])
    expect(appendCapped([a], b)).toEqual([a, b])
  })

  it(`到达上限 ${MAX_ATTACH_IMAGES} 张后不再追加（原列表不变）`, () => {
    const list = Array.from({ length: MAX_ATTACH_IMAGES }, (_, i) => `data:image/png;base64,${i}`)
    expect(appendCapped(list, 'data:image/png;base64,new')).toEqual(list)
    // 原列表未被原地修改
    expect(list).toHaveLength(MAX_ATTACH_IMAGES)
  })
})

describe('imageFilesFromClipboard（粘贴提取，同步纯函数）', () => {
  it('只取 image/* 项；非图片（文本/自定义）忽略', () => {
    const pngFile = new File(['x'], 'shot.png', { type: 'image/png' })
    const items = [
      { type: 'text/plain', getAsFile: () => null },
      { type: 'image/png', getAsFile: () => pngFile },
      { type: 'image/jpeg', getAsFile: () => null }, // 取不到文件也安全跳过
      { type: 'text/html', getAsFile: () => new File(['<b/>'], 'x.html', { type: 'text/html' }) },
    ]
    expect(imageFilesFromClipboard(items)).toEqual([pngFile])
  })

  it('空剪贴板/纯文本粘贴返回空数组', () => {
    expect(imageFilesFromClipboard([])).toEqual([])
    expect(imageFilesFromClipboard([{ type: 'text/plain', getAsFile: () => new File(['hi'], 't.txt') }])).toEqual([])
  })
})

describe('downscaleImage（压缩，失败回落原图）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('jsdom 无法解码图片：超时兜底回落原图（不抛错）', async () => {
    vi.useFakeTimers()
    const raw = 'data:image/png;base64,AAAA'
    const p = downscaleImage(raw)
    vi.advanceTimersByTime(6000)
    await expect(p).resolves.toBe(raw)
  })
})
