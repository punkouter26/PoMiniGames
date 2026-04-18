/**
 * PoMaskString.ts — PII masking utility.
 * Replaces middle characters with '***', keeping first and last visible.
 * Used by PoDiagService before any snapshot data reaches the render layer (FR-030).
 *
 * Edge cases:
 *   - length <= 1  → '***' (mask all — no safe anchor)
 *   - length >= 2  → first + '***' + last  (e.g. "AB" → "A***B", "P0X9K2" → "P***2")
 */
export function poMaskString(value: string): string {
  if (value.length <= 1) return '***';
  return value[0] + '***' + value[value.length - 1];
}
