import notoUrl from '../fonts/NotoSansHebrew-Regular.ttf?url'
import vibesUrl from '../fonts/GreatVibes-Regular.ttf?url'

export type FontMetrics = {
  ascent: number
  descent: number
}

let metrics: FontMetrics = { ascent: 0.8, descent: 0.2 }
let fontBytes: Uint8Array | null = null
let ready: Promise<void> | null = null

export function fontMetrics(): FontMetrics {
  return metrics
}

export function getFontBytes(): Uint8Array | null {
  return fontBytes
}

export function ensureFonts(): Promise<void> {
  if (!ready) ready = load()
  return ready
}

async function load(): Promise<void> {
  const [notoFace, vibesFace, notoRes] = await Promise.all([
    new FontFace('Noto Sans Hebrew', `url(${notoUrl})`).load(),
    new FontFace('Great Vibes', `url(${vibesUrl})`).load(),
    fetch(notoUrl),
  ])
  document.fonts.add(notoFace)
  document.fonts.add(vibesFace)
  fontBytes = new Uint8Array(await notoRes.arrayBuffer())
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.font = '100px "Noto Sans Hebrew"'
  const measured = ctx.measureText('אבMg09')
  const ascent = measured.fontBoundingBoxAscent || 80
  const descent = measured.fontBoundingBoxDescent || 20
  metrics = { ascent: ascent / 100, descent: descent / 100 }
}

const measureCanvas = document.createElement('canvas')

export function measureTextWidth(text: string, fontSize: number): number {
  const ctx = measureCanvas.getContext('2d')
  if (!ctx) return text.length * fontSize * 0.5
  ctx.font = `${fontSize}px "Noto Sans Hebrew"`
  let max = 0
  for (const line of text.split('\n')) {
    max = Math.max(max, ctx.measureText(line || ' ').width)
  }
  return max
}
