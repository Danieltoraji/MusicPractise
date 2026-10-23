/**
 * jsdom Canvas 2D 测试替身（docs/44 R15 / docs/40 H2 起步）。
 *
 * 背景：jsdom 未安装原生 `canvas` 包，`HTMLCanvasElement#getContext('2d')` 会打印
 * 「Not implemented」并返回 null。VexFlow 的 SVGContext 需要 canvas 做文本度量，
 * 导致全量测试输出约 3650 条 not-implemented 噪音（真实失败难以辨认）。
 *
 * 本替身只提供**可执行的最小 2D 上下文**（不做真实像素计算）+ toDataURL/toBlob 桩：
 * - 画布路径（VexFlow 文本度量、缩略图、导出流程）在 jsdom 下可走通；
 * - 不改变浏览器行为：仅在 jsdom（存在 HTMLCanvasElement 且无原生 2D 能力）安装；
 * - 用原型标记保证幂等；node 环境无 HTMLCanvasElement 时直接跳过。
 *
 * 纪律：测试断言不得依赖像素结果（渲染正确性仍归浏览器实测/视觉 smoke，见 docs/44 R15/R17）。
 */

/** 原型标记：防止重复安装 / 便于测试断言 */
export const CANVAS_STUB_MARK = '__dshCanvasStub2d'

/** 1×1 透明 PNG（合法 data URL，供 toDataURL 桩使用） */
export const TEST_PIXEL_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const noop = (): void => {}

/** 2D 上下文最小实现（方法 no-op；度量给稳定近似值；未知 API 由 Proxy 兜底 no-op） */
function createStub2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const gradient = { addColorStop: noop }
  const target: Record<string, unknown> = {
    canvas,
    // 文本度量：VexFlow 只用 width 做布局；给按字符数的稳定近似（固定宽度，避免字体依赖）
    measureText: (text: string): TextMetrics => {
      const s = String(text ?? '')
      const width = s.length * 6
      return {
        width,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        fontBoundingBoxAscent: 8,
        fontBoundingBoxDescent: 2,
        alphabeticBaseline: 0,
        hangingBaseline: 0,
        ideographicBaseline: 0,
      } as TextMetrics
    },
    getImageData: (_sx: number, _sy: number, w: number, h: number): ImageData => {
      const width = Math.max(1, w | 0)
      const height = Math.max(1, h | 0)
      return { data: new Uint8ClampedArray(width * height * 4), width, height, colorSpace: 'srgb' } as ImageData
    },
    createImageData: (w: number, h: number): ImageData => {
      const width = Math.max(1, w | 0)
      const height = Math.max(1, h | 0)
      return { data: new Uint8ClampedArray(width * height * 4), width, height, colorSpace: 'srgb' } as ImageData
    },
    createLinearGradient: (): CanvasGradient => gradient as unknown as CanvasGradient,
    createRadialGradient: (): CanvasGradient => gradient as unknown as CanvasGradient,
    createPattern: (): CanvasPattern => ({ setTransform: noop }) as unknown as CanvasPattern,
    getLineDash: (): number[] => [],
    getTransform: (): DOMMatrix => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as DOMMatrix,
    isPointInPath: (): boolean => false,
    isPointInStroke: (): boolean => false,
    // 绘制/变换路径：no-op
    save: noop,
    restore: noop,
    scale: noop,
    translate: noop,
    rotate: noop,
    transform: noop,
    setTransform: noop,
    resetTransform: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    bezierCurveTo: noop,
    quadraticCurveTo: noop,
    arc: noop,
    arcTo: noop,
    rect: noop,
    roundRect: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    strokeText: noop,
    drawImage: noop,
    putImageData: noop,
    setLineDash: noop,
    // 常用状态属性（VexFlow 会读回部分值）
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '10px sans-serif',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    shadowColor: 'rgba(0,0,0,0)',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    letterSpacing: '0px',
    wordSpacing: '0px',
    direction: 'ltr',
    filter: 'none',
  }
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'string' && prop in obj) return obj[prop]
      // 未知 API：返回 no-op 兜底（防止 VexFlow/后续库升级新增调用把测试打挂）
      return noop
    },
    set(obj, prop, value) {
      if (typeof prop === 'string') obj[prop] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

/**
 * 安装 jsdom canvas 替身；返回是否本次安装（幂等/非 jsdom 返回 false）。
 * 由 `src/test/setup.ts` 在测试启动时调用。
 */
export function installCanvasStub(): boolean {
  if (typeof HTMLCanvasElement === 'undefined') return false
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>
  if (proto[CANVAS_STUB_MARK]) return false
  proto[CANVAS_STUB_MARK] = true

  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>()
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function getContextStub(
    this: HTMLCanvasElement,
    contextId: string,
    ...args: unknown[]
  ): unknown {
    if (contextId === '2d') {
      let ctx = contexts.get(this)
      if (!ctx) {
        ctx = createStub2d(this)
        contexts.set(this, ctx)
      }
      return ctx
    }
    // 其它上下文（webgl 等）保持 jsdom 原始行为（会提示 not implemented，但项目未使用）
    return (originalGetContext as unknown as (...a: unknown[]) => unknown).call(this, contextId, ...args)
  } as typeof HTMLCanvasElement.prototype.getContext

  // toDataURL / toBlob：jsdom 同样 not implemented；桩只保证 API 可调用（不产出真实图片）
  HTMLCanvasElement.prototype.toDataURL = (): string => TEST_PIXEL_DATA_URL
  HTMLCanvasElement.prototype.toBlob = function toBlobStub(
    callback: BlobCallback,
    type?: string,
    _quality?: unknown,
  ): void {
    queueMicrotask(() => callback(new Blob([], { type: type ?? 'image/png' })))
  }

  return true
}

/** 是否为已安装的假 2D 上下文（测试断言用） */
export function isStub2dContext(ctx: unknown): boolean {
  return !!ctx && typeof ctx === 'object' && (ctx as Record<string, unknown>).canvas instanceof HTMLCanvasElement
}
