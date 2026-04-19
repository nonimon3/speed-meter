/**
 * 速度の大きい数字を Canvas で描いて PNG (Uint8Array) を返す。
 * G2 のデフォルトフォントは固定サイズなので、大きい数字を出すにはこの方式を使う。
 *
 * BLE 帯域対策:
 *  - 描画後に 1-bit 量子化 (黒/白のみ) → 巨大な黒ベタ領域 + 細い白文字だけになり、
 *    PNG の DEFLATE がフィルタ 0 の行を強く圧縮できるため ~数百バイトまで縮む。
 *  - 文字も太めにして輪郭のグレーピクセルが残らないようにする。
 *  - G2 ファームは 4-bit グレー + ホスト側ディザだが、ここでは 2 値送信で十分。
 */

const CANVAS_W = 240
const CANVAS_H = 144
/** 白/黒の閾値。Canvas の反エイリアス輪郭を切って 1-bit 化する。 */
const THRESHOLD = 96
/** 描画用キャンバスを使い回して GC 圧力を減らす */
let cachedCanvas: HTMLCanvasElement | null = null

function getCanvas(): HTMLCanvasElement {
  if (cachedCanvas) return cachedCanvas
  const c = document.createElement('canvas')
  c.width = CANVAS_W
  c.height = CANVAS_H
  cachedCanvas = c
  return c
}

function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxH: number,
): number {
  let size = maxH
  ctx.font = `bold ${size}px "SF Pro Display", "Helvetica Neue", Arial, sans-serif`
  while (size > 24 && ctx.measureText(text).width > maxW) {
    size -= 4
    ctx.font = `bold ${size}px "SF Pro Display", "Helvetica Neue", Arial, sans-serif`
  }
  return size
}

export interface RenderedSpeedPng {
  bytes: Uint8Array
  width: number
  height: number
}

export async function renderSpeedNumberPng(text: string): Promise<RenderedSpeedPng> {
  const canvas = getCanvas()
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')

  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  // 左右・上下に余白 (6%) を残してフィット
  const padX = CANVAS_W * 0.06
  const padY = CANVAS_H * 0.08
  const maxW = CANVAS_W - padX * 2
  const maxH = CANVAS_H - padY * 2

  fitFontSize(ctx, text, maxW, maxH)

  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, CANVAS_W / 2, CANVAS_H / 2)

  // 1-bit 量子化: RGBA を 黒(0,0,0,255) / 白(255,255,255,255) のどちらかに潰す。
  // PNG の DEFLATE が効いて体感で数百バイトまで縮む。
  const img = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H)
  const data = img.data
  for (let i = 0; i < data.length; i += 4) {
    // 白を #fff で塗っているので R チャネルだけで判定して十分
    const bit = data[i] > THRESHOLD ? 255 : 0
    data[i] = bit
    data[i + 1] = bit
    data[i + 2] = bit
    data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas.toBlob returned null')
  const buf = await blob.arrayBuffer()
  return { bytes: new Uint8Array(buf), width: CANVAS_W, height: CANVAS_H }
}

export const SPEED_IMAGE_SIZE = { width: CANVAS_W, height: CANVAS_H }
