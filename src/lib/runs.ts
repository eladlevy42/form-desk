import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextEdit, TextRun } from './types.ts'

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
    items.forEach((item, index) => {
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
      runs.push({
        id: `p${pageNumber - 1}:${Math.round(baseline * 10)}:${Math.round(x * 10)}:${index}`,
        page: pageNumber - 1,
        x,
        baseline,
        width,
        fontSize,
        color: colors.ink,
        background: colors.background,
        text: item.str,
        dir: item.dir === 'rtl' ? 'rtl' : 'ltr',
        ascent,
        descent,
        bold: false,
      })
    })
  }
  return runs
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
