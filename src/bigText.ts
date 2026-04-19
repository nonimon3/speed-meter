/**
 * 大きい数字を "ドット絵" でテキスト化する。
 *
 * Simulator フォント制約:
 *   - U+2580 ▀ / U+2584 ▄ (半角ブロック) は glyph が未収録 → レンダー不可
 *   - U+2588 █ (FULL BLOCK) と U+3000 '　' (IDEOGRAPHIC SPACE) は使える
 *   - よってこの2文字だけで組む (East Asian Wide で幅が同じ → 列揃い保証)
 *
 * 行数は 5 行。G2 TextContainer は line-height を制御できないためフォント行間
 * ギャップは受け入れる。
 */

const FW_SPACE = '\u3000'
const FULL = '\u2588'  // █

const PIXELS: Record<string, string[]> = {
  '0': ['11111', '10001', '10001', '10001', '11111'],
  '1': ['00100', '01100', '00100', '00100', '01110'],
  '2': ['11111', '00001', '11111', '10000', '11111'],
  '3': ['11111', '00001', '11111', '00001', '11111'],
  '4': ['10001', '10001', '11111', '00001', '00001'],
  '5': ['11111', '10000', '11111', '00001', '11111'],
  '6': ['11111', '10000', '11111', '10001', '11111'],
  '7': ['11111', '00001', '00001', '00001', '00001'],
  '8': ['11111', '10001', '11111', '10001', '11111'],
  '9': ['11111', '10001', '11111', '00001', '11111'],
  '-': ['00000', '00000', '11111', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000'],
}

function toGlyph(bits: string[]): string[] {
  return bits.map((row) =>
    [...row].map((b) => (b === '1' ? FULL : FW_SPACE)).join(''),
  )
}

const GLYPH: Record<string, string[]> = Object.fromEntries(
  Object.entries(PIXELS).map(([k, bits]) => [k, toGlyph(bits)]),
)

export const BIG_DIGIT_ROWS = 5
/** 全角セル換算の 1 桁幅 */
export const BIG_DIGIT_COLS = 5
/** 全角セル換算の桁間ギャップ */
export const BIG_DIGIT_GAP = 1

export function bigDigits(text: string): string {
  const rows = Array.from({ length: BIG_DIGIT_ROWS }, () => '')
  const chars = [...text]
  for (let n = 0; n < chars.length; n++) {
    const glyph = GLYPH[chars[n]] ?? GLYPH[' ']
    for (let i = 0; i < BIG_DIGIT_ROWS; i++) {
      rows[i] += (n > 0 ? FW_SPACE : '') + glyph[i]
    }
  }
  return rows.join('\n')
}

/** 576 / 22 ≒ 26 全角セルが 1 行に入る想定の中央寄せ indent。 */
export function bigDigitsCenteringIndent(text: string, totalCells = 26): number {
  const chars = [...text]
  const width = chars.length * BIG_DIGIT_COLS + Math.max(0, chars.length - 1) * BIG_DIGIT_GAP
  return Math.max(0, Math.floor((totalCells - width) / 2))
}

/** 右端を rightEdge (全角セル位置) で固定したときの左 indent。
 *  例: 右端=19 で 1桁="9" → indent=14、"99" → 8、"100" → 2。
 *  これを使うと数字の一の位が常に同じ x に並ぶ。 */
export function bigDigitsRightAlignIndent(text: string, rightEdge = 19): number {
  const chars = [...text]
  const width = chars.length * BIG_DIGIT_COLS + Math.max(0, chars.length - 1) * BIG_DIGIT_GAP
  return Math.max(0, rightEdge - width)
}

export function padAllRows(block: string, leftCells: number): string {
  if (leftCells <= 0) return block
  const pad = FW_SPACE.repeat(leftCells)
  return block.split('\n').map((line) => pad + line).join('\n')
}

export { FW_SPACE }
