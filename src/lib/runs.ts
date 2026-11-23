import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextEdit, TextPart, TextRun } from './types.ts'

export type LooseGlyph = TextPart & {
  dir: 'ltr' | 'rtl'
  color: string
  background: string
}

type Glyph = {
  str: string
  dir: string
  width: number
  height: number
  transform: number[]
  fontName: string
}

type Style = { ascent?: number; descent?: number }

export async function extractRuns(pdf: PDFDocumentProxy): Promise<TextRun[]> {
  const runs: TextRun[] = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const styles = content.styles as Record<string, Style>
    const items = content.items.filter((item) => 'str' in item && item.str.trim().length > 0) as Glyph[]
    const sampled = await renderForSampling(page)
    const glyphs: LooseGlyph[] = items.map((item) => {
      const transform = item.transform as number[]
      const [x, baseline] = viewport.convertToViewportPoint(transform[4] ?? 0, transform[5] ?? 0)
      const fontSize = round1(Math.hypot(transform[2] ?? 0, transform[3] ?? 0) || Math.hypot(transform[0] ?? 0, transform[1] ?? 0) || item.height || 12)
      const style = styles[item.fontName] ?? {}
      const ascent = style.ascent && style.ascent > 0 ? style.ascent : 0.8
      const descent = style.descent == null ? 0.2 : Math.abs(style.descent)
      const width = Math.max(item.width || fontSize * 0.4, 1)
      const top = baseline - ascent * fontSize
      const height = Math.max((ascent + descent) * fontSize, 1)
      const colors = sampled ? sampleColors(sampled.ctx, sampled.scale, x, top, width, height) : { ink: '#1a1714', background: '#ffffff' }
      return {
        x,
        baseline,
        width,
        text: item.str,
        fontSize,
        ascent,
        descent,
        dir: item.dir === 'rtl' ? 'rtl' : 'ltr',
        color: colors.ink,
        background: colors.background,
      }
    })
    groupGlyphs(glyphs).forEach((group, index) => {
      const first = group[0]
      const end = Math.max(...group.map((part) => part.x + part.width))
      runs.push({
        id: `p${pageNumber - 1}:${Math.round(first.baseline * 10)}:${Math.round(first.x * 10)}:${index}`,
        page: pageNumber - 1,
        x: first.x,
        baseline: first.baseline,
        width: Math.max(end - first.x, 1),
        fontSize: first.fontSize,
        color: first.color,
        background: first.background,
        text: joinGlyphText(group),
        dir: first.dir,
        ascent: first.ascent,
        descent: first.descent,
        bold: false,
        parts: group.map((part) => ({
          x: part.x,
          baseline: part.baseline,
          width: part.width,
          text: part.text,
          fontSize: part.fontSize,
          ascent: part.ascent,
          descent: part.descent,
        })),
      })
    })
  }
  return runs
}

/** Merge fragments on one baseline. Cell-sized gaps stay separate. */
export function groupGlyphs(glyphs: LooseGlyph[]): LooseGlyph[][] {
  const sorted = [...glyphs].sort((a, b) => a.baseline - b.baseline || a.x - b.x)
  const lines: LooseGlyph[][] = []
  for (const glyph of sorted) {
    const line = lines.find((entry) => Math.abs(entry[0].baseline - glyph.baseline) <= Math.max(1.25, Math.min(entry[0].fontSize, glyph.fontSize) * 0.28))
    if (line) line.push(glyph)
    else lines.push([glyph])
  }
  const groups: LooseGlyph[][] = []
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x)
    let current: LooseGlyph[] = []
    for (const glyph of line) {
      const prev = current[current.length - 1]
      if (!prev || !shouldJoin(prev, glyph)) {
        if (current.length) groups.push(current)
        current = [glyph]
      } else {
        current.push(glyph)
      }
    }
    if (current.length) groups.push(current)
  }
  return groups
}

function shouldJoin(prev: LooseGlyph, next: LooseGlyph): boolean {
  if (prev.dir !== next.dir) return false
  const gap = next.x - (prev.x + prev.width)
  const size = Math.min(prev.fontSize, next.fontSize)
  if (Math.abs(prev.fontSize - next.fontSize) > Math.max(1.5, size * 0.35)) return false
  const kern = Math.max(0.45, size * 0.06)
  if (gap <= kern) return true
  const loose = Math.min(3.1, Math.max(2.2, size * 0.3))
  if (gap > loose || gap < -size * 0.4) return false
  return tokenJoin(prev.text, next.text)
}

/** True when two nearby fragments are one time, date, number, range, or AM/PM. */
export function tokenJoin(left: string, right: string): boolean {
  const a = left.trim()
  const b = right.trim()
  if (!a || !b) return false
  if (/[A-Za-z]{2,}/.test(a) && /[A-Za-z]{2,}/.test(b) && !/^(am|pm|a\.m\.|p\.m\.)$/i.test(b)) return false
  if (/^(am|pm|a\.m\.|p\.m\.)$/i.test(b) && /\d/.test(a)) return true
  const joined = (a + b).replace(/\s/g, '')
  if (/^[\d:]+$/.test(a) && /^[\d:]+$/.test(b)) {
    if (a.includes(':') && b.includes(':')) return false
    return /^\d{0,2}:?\d{0,2}:?\d{0,2}$/.test(joined)
  }
  if (a.includes(':') && b.includes(':') && !a.endsWith('-') && !b.startsWith('-')) return false
  if (/^\d{1,2}:\d{2}(-\d{1,2}:\d{2})?$/.test(joined)) return true
  if (/^\d{1,2}(:\d{0,2}){0,2}$/.test(joined) && !(a.includes(':') && b.includes(':'))) return true
  if (/^\d{1,4}([/.]\d{1,4}){1,3}$/.test(joined)) return true
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(joined)) return true
  if (/^\d{1,3}(,\d{0,3})*$/.test(joined) && (a.endsWith(',') || b.startsWith(','))) return true
  if (/^\d{1,3}(,\d{3})*\.\d*$/.test(joined) && (a.endsWith('.') || b.startsWith('.'))) return true
  if (a.endsWith('-') && /^\d/.test(b)) return true
  if (b.startsWith('-') && /\d$/.test(a)) return true
  return false
}

export function joinGlyphText(parts: Array<{ x: number; width: number; text: string; fontSize: number }>): string {
  let text = ''
  let prev: (typeof parts)[number] | null = null
  for (const part of parts) {
    if (!prev) {
      text = part.text
      prev = part
      continue
    }
    const gap = part.x - (prev.x + prev.width)
    text += gap > Math.max(1.2, prev.fontSize * 0.18) ? ` ${part.text.trim()}` : part.text
    prev = part
  }
  return text
}

export function combineRuns(runs: TextRun[]): TextRun {
  const sorted = [...runs].sort((a, b) => a.baseline - b.baseline || a.x - b.x)
  const parts = sorted.flatMap((run) => (run.parts.length ? run.parts : [partFromRun(run)]))
  const first = parts[0]
  const end = Math.max(...parts.map((part) => part.x + part.width))
  return {
    id: `m-${Math.round(first.x)}-${Math.round(first.baseline)}-${parts.length}-${sorted[0].id}`,
    page: sorted[0].page,
    x: first.x,
    baseline: first.baseline,
    width: Math.max(end - first.x, 1),
    fontSize: first.fontSize,
    color: sorted[0].color,
    background: sorted[0].background,
    text: joinGlyphText(parts),
    dir: sorted[0].dir,
    ascent: first.ascent,
    descent: first.descent,
    bold: false,
    parts,
  }
}

export function splitRunText(run: TextRun, at: number): TextRun[] {
  const cut = Math.min(run.text.length - 1, Math.max(1, at))
  const leftText = run.text.slice(0, cut)
  const rightText = run.text.slice(cut)
  const leftWidth = Math.max(12, run.width * (leftText.length / run.text.length))
  const rightWidth = Math.max(12, run.width - leftWidth)
  const leftPart: TextPart = {
    x: run.x,
    baseline: run.baseline,
    width: leftWidth,
    text: leftText,
    fontSize: run.fontSize,
    ascent: run.ascent,
    descent: run.descent,
  }
  const rightPart: TextPart = { ...leftPart, x: run.x + leftWidth, width: rightWidth, text: rightText }
  return [pieceRun(run, leftPart, 'a'), pieceRun(run, rightPart, 'b')]
}

function pieceRun(run: TextRun, part: TextPart, suffix: string): TextRun {
  return {
    ...run,
    id: `${run.id}-${suffix}`,
    x: part.x,
    width: part.width,
    text: part.text,
    parts: [part],
  }
}

export function splitRun(run: TextRun): TextRun[] {
  if (run.parts.length < 2) return [run]
  return run.parts.map((part, index) => ({
    id: `${run.id}-s${index}`,
    page: run.page,
    x: part.x,
    baseline: part.baseline,
    width: part.width,
    fontSize: part.fontSize,
    color: run.color,
    background: run.background,
    text: part.text,
    dir: run.dir,
    ascent: part.ascent,
    descent: part.descent,
    bold: false,
    parts: [part],
  }))
}

function partFromRun(run: TextRun): TextPart {
  return {
    x: run.x,
    baseline: run.baseline,
    width: run.width,
    text: run.text,
    fontSize: run.fontSize,
    ascent: run.ascent,
    descent: run.descent,
  }
}

export function partCover(part: TextPart): { x: number; y: number; width: number; height: number } {
  const padX = 0.7
  const padY = 0.55
  return {
    x: part.x - padX,
    y: part.baseline - part.ascent * part.fontSize - padY,
    width: part.width + padX * 2,
    height: (part.ascent + part.descent) * part.fontSize + padY * 2,
  }
}

export function runCoverBox(run: TextRun): { x: number; y: number; width: number; height: number } {
  const padX = 0.9
  const padY = 0.75
  return {
    x: run.x - padX,
    y: run.baseline - run.ascent * run.fontSize - padY,
    width: run.width + padX * 2,
    height: (run.ascent + run.descent) * run.fontSize + padY * 2,
  }
}

export function editDiffers(edit: TextEdit, run: TextRun): boolean {
  if (edit.deleted) return true
  if (edit.text !== run.text) return true
  if (Math.abs(edit.x - run.x) > 0.4 || Math.abs(edit.baseline - run.baseline) > 0.4) return true
  if (Math.abs(edit.fontSize - run.fontSize) > 0.15) return true
  if (edit.color.toLowerCase() !== run.color.toLowerCase()) return true
  if (edit.bold !== run.bold) return true
  if (Math.abs((edit.boxWidth ?? run.width) - run.width) > 0.8) return true
  const naturalHeight = (run.ascent + run.descent) * run.fontSize
  if (Math.abs((edit.boxHeight ?? naturalHeight) - naturalHeight) > 0.8) return true
  if ((edit.align ?? 'auto') !== 'auto') return true
  if (edit.underline) return true
  if (edit.background) return true
  if (edit.font && edit.font !== 'noto') return true
  return false
}

async function renderForSampling(page: PDFPageProxy): Promise<{ ctx: CanvasRenderingContext2D; scale: number } | null> {
  const scale = 2
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(viewport.width))
  canvas.height = Math.max(1, Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try {
    await page.render({ canvas, viewport }).promise
  } catch {
    return null
  }
  return { ctx, scale }
}

function sampleColors(
  ctx: CanvasRenderingContext2D,
  scale: number,
  x: number,
  y: number,
  w: number,
  h: number,
): { ink: string; background: string } {
  const pad = Math.max(1, Math.round(scale * 0.5))
  const sx = clampInt(Math.floor(x * scale) - pad, 0, ctx.canvas.width - 1)
  const sy = clampInt(Math.floor(y * scale) - pad, 0, ctx.canvas.height - 1)
  const sw = clampInt(Math.ceil(w * scale) + pad * 2, 1, ctx.canvas.width - sx)
  const sh = clampInt(Math.ceil(h * scale) + pad * 2, 1, ctx.canvas.height - sy)
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(sx, sy, sw, sh).data
  } catch {
    return { ink: '#1a1714', background: '#ffffff' }
  }
  const dark: Array<[number, number, number]> = []
  const light: Array<[number, number, number]> = []
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] ?? 0
    if (alpha < 160) continue
    const rgb: [number, number, number] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]
    const lum = rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11
    if (lum < 145) dark.push(rgb)
    else if (lum > 196) light.push(rgb)
  }
  return {
    ink: medianHex(dark) ?? '#1a1714',
    background: medianHex(light) ?? '#ffffff',
  }
}

function medianHex(pixels: Array<[number, number, number]>): string | null {
  if (pixels.length < 6) return null
  const channels = [0, 1, 2].map((channel) => {
    const values = pixels.map((pixel) => pixel[channel]).sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)] ?? 0
  })
  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
