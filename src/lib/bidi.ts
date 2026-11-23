import bidiFactory from 'bidi-js'
import type { Align } from './types.ts'

const bidi = bidiFactory()

export function hasHebrew(text: string): boolean {
  return /[\u0590-\u05FF]/.test(text)
}

/** First strong character decides the paragraph direction. */
export function baseDirection(text: string): 'rtl' | 'ltr' {
  for (const ch of text) {
    if (/[\u0590-\u05FF\u0600-\u06FF]/.test(ch)) return 'rtl'
    if (/[A-Za-z]/.test(ch)) return 'ltr'
  }
  return 'ltr'
}

export function resolvedAlign(align: Align, text: string): 'left' | 'center' | 'right' {
  if (align === 'left' || align === 'center' || align === 'right') return align
  return baseDirection(text) === 'rtl' ? 'right' : 'left'
}

/**
 * pdf-lib draws glyphs left to right. Hebrew needs visual order first.
 * Latin and digits stay in their own runs.
 */
export function toVisual(text: string): string {
  if (!text || !/[\u0590-\u05FF\u0600-\u06FF]/.test(text)) return text
  const levels = bidi.getEmbeddingLevels(text, baseDirection(text))
  return bidi.getReorderedString(text, levels)
}
