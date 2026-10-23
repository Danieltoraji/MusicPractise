// @vitest-environment jsdom
/**
 * Canvas 2D 替身回归（docs/44 R15）：确保 jsdom 下画布 API 可调用且不再产生
 * not-implemented（VexFlow 文本度量的前置条件），同时显式声明「不产真实像素」的边界。
 */
import { describe, expect, it } from 'vitest'
import { CANVAS_STUB_MARK, installCanvasStub, isStub2dContext, TEST_PIXEL_DATA_URL } from './canvasStub'

const canvas = (): HTMLCanvasElement => {
  const el = document.createElement('canvas')
  el.width = 40
  el.height = 20
  return el
}

describe('jsdom Canvas 2D 替身', () => {
  it('setup 已安装且幂等：原型带标记，二次安装返回 false', () => {
    expect((HTMLCanvasElement.prototype as unknown as Record<string, unknown>)[CANVAS_STUB_MARK]).toBe(true)
    expect(installCanvasStub()).toBe(false)
    expect(isStub2dContext(canvas().getContext('2d'))).toBe(true)
  })

  it('getContext("2d") 返回可调用上下文：同一 canvas 复用，度量有稳定宽度', () => {
    const el = canvas()
    const ctx = el.getContext('2d')!
    expect(el.getContext('2d')).toBe(ctx)
    expect(ctx.measureText('abc').width).toBe(18)
    expect(ctx.measureText('').width).toBe(0)
    // 未知方法有 no-op 兜底（VexFlow/库升级不把测试打挂）
    expect(typeof (ctx as unknown as Record<string, () => void>).someFutureApi).toBe('function')
  })

  it('绘制/变换/渐变/像素 API 全部可调用（不抛错）', () => {
    const ctx = canvas().getContext('2d')!
    const grad = ctx.createLinearGradient(0, 0, 10, 10)
    grad.addColorStop(0, '#fff')
    ctx.save()
    ctx.scale(1, 1)
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 10, 10)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(10, 10)
    ctx.stroke()
    ctx.drawImage(canvas(), 0, 0, 10, 10)
    ctx.restore()
    const image = ctx.getImageData(0, 0, 2, 3)
    expect(image.width).toBe(2)
    expect(image.height).toBe(3)
    expect(image.data.length).toBe(2 * 3 * 4)
  })

  it('toDataURL 返回合法 PNG data URL；toBlob 异步回传 Blob', async () => {
    const el = canvas()
    expect(el.toDataURL('image/png')).toBe(TEST_PIXEL_DATA_URL)
    expect(TEST_PIXEL_DATA_URL.startsWith('data:image/png;base64,')).toBe(true)
    const blob = await new Promise<Blob | null>((resolve) => el.toBlob(resolve, 'image/jpeg'))
    expect(blob).toBeInstanceOf(Blob)
    expect(blob!.type).toBe('image/jpeg')
  })
})
