// A 5×7 block-capital bitmap font, drawn one fat pixel per bit, for everything PoMule writes
// on its canvas. Home-made in the style of an 8-bit character set; no font file involved.
// Each glyph is seven rows, one number per row, bit 4 = leftmost pixel.

const GLYPHS = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 27, 17], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31],
  3: [30, 1, 1, 14, 1, 1, 30], 4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14],
  9: [14, 17, 17, 15, 1, 2, 12],
  '.': [0, 0, 0, 0, 0, 0, 4], ',': [0, 0, 0, 0, 0, 4, 8], ':': [0, 4, 0, 0, 4, 0, 0],
  '#': [10, 10, 31, 10, 31, 10, 10], $: [4, 15, 20, 14, 5, 30, 4], '-': [0, 0, 0, 31, 0, 0, 0],
  '+': [0, 4, 4, 31, 4, 4, 0], '/': [1, 2, 2, 4, 8, 8, 16], '!': [4, 4, 4, 4, 4, 0, 4],
  '?': [14, 17, 1, 2, 4, 0, 4], "'": [4, 4, 0, 0, 0, 0, 0], '%': [25, 26, 2, 4, 8, 11, 19],
  '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8], '=': [0, 0, 31, 0, 31, 0, 0],
};

export const CHAR_W = 6; // five pixels and a one-pixel gap
export const CHAR_H = 8;

/** Pixel width of a string at the given scale. */
export function textWidth(text, scale = 1) {
  return String(text).length * CHAR_W * scale;
}

/**
 * Draws text with its top-left at (x, y). Lower case is drawn as capitals; anything the
 * font has no glyph for is a space. `align`: 'left', 'center' or 'right' of x.
 */
export function drawText(ctx, text, x, y, color, scale = 1, align = 'left') {
  const s = String(text).toUpperCase();
  let left = Math.round(align === 'center' ? x - textWidth(s, scale) / 2 : align === 'right' ? x - textWidth(s, scale) : x);
  ctx.fillStyle = color;
  for (const ch of s) {
    const rows = GLYPHS[ch];
    if (rows) {
      for (let r = 0; r < 7; r++) {
        for (let b = 0; b < 5; b++) {
          if (rows[r] & (16 >> b)) ctx.fillRect(left + b * scale, y + r * scale, scale, scale);
        }
      }
    }
    left += CHAR_W * scale;
  }
}
