import { toVisual } from './bidi.ts'

export type Rect = { x: number; y: number; w: number; h: number }
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export type Guide = { axis: 'x' | 'y'; at: number }

const MIN_W = 28
const MIN_H = 12

export function resizeRect(orig: Rect, mode: Handle, dx: number, dy: number, minW = MIN_W, minH = MIN_H): Rect {
  let { x, y, w, h } = orig
  if (mode.includes('e')) w = orig.w + dx
  if (mode.includes('s')) h = orig.h + dy
  if (mode.includes('w')) {
    w = orig.w - dx
    x = orig.x + dx
  }
  if (mode.includes('n')) {
    h = orig.h - dy
    y = orig.y + dy
  }
  if (w < minW) {
    if (mode.includes('w')) x -= minW - w
    w = minW
  }
  if (h < minH) {
    if (mode.includes('n')) y -= minH - h
    h = minH
  }
  return { x, y, w, h }
}

export function wrapParagraph(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  const width = Math.max(8, maxWidth)
  if (!text) return ['']
  const tokens = text.split(/(\s+)/).filter((token) => token.length > 0)
  const lines: string[] = []
  let current = ''
  const commit = () => {
    lines.push(current.replace(/\s+$/u, ''))
    current = ''
  }
  const breakWord = (word: string) => {
    let chunk = ''
    for (const ch of word) {
      const next = chunk + ch
      if (chunk && measure(next) > width) {
        lines.push(chunk)
        chunk = ch
      } else {
        chunk = next
      }
    }
    current = chunk
  }
  for (const token of tokens) {
    if (/^\s+$/u.test(token)) {
      if (!current) continue
      if (measure(current + ' ') <= width) current += ' '
      else commit()
      continue
    }
    const next = current + token
    if (!current || measure(next) <= width) current = next
    else {
      if (current) commit()
      if (measure(token) <= width) current = token
      else breakWord(token)
    }
  }
  if (current || lines.length === 0) lines.push(current.replace(/\s+$/u, ''))
  return lines
}

export function layoutLines(text: string, maxWidth: number, maxLines: number, measure: (value: string) => number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) lines.push(...wrapParagraph(para, maxWidth, measure))
  if (maxLines > 0 && lines.length > maxLines) return lines.slice(0, maxLines)
  return lines.length ? lines : ['']
}

export function visualMeasure(measure: (value: string) => number): (value: string) => number {
  return (value: string) => measure(toVisual(value))
}

type SnapTarget = { x: number; y: number; w: number; h: number }

export function snapRect(rect: Rect, targets: SnapTarget[], threshold = 5): { rect: Rect; guides: Guide[] } {
  const guides: Guide[] = []
  let { x, y } = rect
  const xs = [rect.x, rect.x + rect.w / 2, rect.x + rect.w]
  const ys = [rect.y, rect.y + rect.h / 2, rect.y + rect.h]
  let bestX: { delta: number; at: number } | null = null
  let bestY: { delta: number; at: number } | null = null
  for (const target of targets) {
    const tx = [target.x, target.x + target.w / 2, target.x + target.w]
    const ty = [target.y, target.y + target.h / 2, target.y + target.h]
    for (const edge of xs) {
      for (const other of tx) {
        const delta = other - edge
        if (Math.abs(delta) > threshold) continue
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) bestX = { delta, at: other }
      }
    }
    for (const edge of ys) {
      for (const other of ty) {
        const delta = other - edge
        if (Math.abs(delta) > threshold) continue
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) bestY = { delta, at: other }
      }
    }
  }
  if (bestX) {
    x += bestX.delta
    guides.push({ axis: 'x', at: bestX.at })
  }
  if (bestY) {
    y += bestY.delta
    guides.push({ axis: 'y', at: bestY.at })
  }
  return { rect: { ...rect, x, y }, guides }
}
