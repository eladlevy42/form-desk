import { useEffect, useRef, useState } from 'react'

type Tab = 'draw' | 'type' | 'upload'

type Props = {
  onCancel: () => void
  onUse: (dataUrl: string, aspect: number) => void
}

export function SignatureDialog({ onCancel, onUse }: Props) {
  const [tab, setTab] = useState<Tab>('draw')
  const [typed, setTyped] = useState('')
  const drawRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const lastPt = useRef<{ x: number; y: number } | null>(null)
  const [uploadUrl, setUploadUrl] = useState<string | null>(null)

  useEffect(() => {
    const canvas = drawRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const ratio = Math.max(1, window.devicePixelRatio || 1)
    const width = canvas.clientWidth || 640
    const height = canvas.clientHeight || 180
    canvas.width = Math.floor(width * ratio)
    canvas.height = Math.floor(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#1a1714'
    ctx.lineWidth = 2.4
  }, [tab])

  function pointer(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = drawRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onDrawDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = drawRef.current?.getContext('2d')
    const pt = pointer(e)
    if (!ctx || !pt) return
    drawing.current = true
    lastPt.current = pt
    e.currentTarget.setPointerCapture(e.pointerId)
    ctx.beginPath()
    ctx.moveTo(pt.x, pt.y)
  }

  function onDrawMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = drawRef.current?.getContext('2d')
    const pt = pointer(e)
    const prev = lastPt.current
    if (!ctx || !pt || !prev) return
    ctx.beginPath()
    ctx.moveTo(prev.x, prev.y)
    ctx.lineTo(pt.x, pt.y)
    ctx.stroke()
    lastPt.current = pt
  }

  function onDrawUp() {
    drawing.current = false
    lastPt.current = null
  }

  function clearDraw() {
    const canvas = drawRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  function useDrawing() {
    const canvas = drawRef.current
    if (!canvas) return
    const trimmed = trimCanvas(canvas)
    onUse(trimmed.toDataURL('image/png'), trimmed.width / trimmed.height)
  }

  function useTyped() {
    const name = typed.trim()
    if (!name) return
    const canvas = renderTyped(name)
    const trimmed = trimCanvas(canvas)
    onUse(trimmed.toDataURL('image/png'), trimmed.width / trimmed.height)
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    const url = await fileToPng(file)
    setUploadUrl(url)
  }

  function useUpload() {
    if (!uploadUrl) return
    const image = new Image()
    image.onload = () => {
      onUse(uploadUrl, image.width / image.height || 3)
    }
    image.src = uploadUrl
  }

  return (
    <div className="modal-back" role="presentation" onMouseDown={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-labelledby="sign-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="sign-title">Add a signature</h2>
        <p className="muted">Draw it, type it, or upload a picture. Then click the page to place it.</p>
        <div className="tabs" role="tablist">
          {(['draw', 'type', 'upload'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'tab on' : 'tab'}
              onClick={() => setTab(id)}
            >
              {id === 'draw' ? 'Draw' : id === 'type' ? 'Type' : 'Upload'}
            </button>
          ))}
        </div>

        {tab === 'draw' ? (
          <div>
            <canvas
              ref={drawRef}
              className="sign-pad"
              data-testid="signature-pad"
              onPointerDown={onDrawDown}
              onPointerMove={onDrawMove}
              onPointerUp={onDrawUp}
              onPointerCancel={onDrawUp}
            />
            <div className="row-actions">
              <button type="button" className="btn" onClick={clearDraw}>
                Clear
              </button>
              <button type="button" className="btn primary" data-testid="signature-use" onClick={useDrawing}>
                Use this signature
              </button>
            </div>
          </div>
        ) : null}

        {tab === 'type' ? (
          <div>
            <label className="field-label" htmlFor="sign-name">
              Name
            </label>
            <input
              id="sign-name"
              className="text-input sign-type"
              data-testid="signature-type"
              value={typed}
              dir="auto"
              placeholder="Elad Levy"
              onChange={(e) => setTyped(e.target.value)}
            />
            <div className={`sign-preview ${hebrew(typed) ? 'heb' : 'script'}`} dir={hebrew(typed) ? 'rtl' : 'ltr'}>
              {typed.trim() || 'Your name'}
            </div>
            <div className="row-actions">
              <button type="button" className="btn primary" data-testid="signature-use" onClick={useTyped} disabled={!typed.trim()}>
                Use this signature
              </button>
            </div>
          </div>
        ) : null}

        {tab === 'upload' ? (
          <div>
            <label className="btn" htmlFor="sign-file">
              Choose image
            </label>
            <input
              id="sign-file"
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              data-testid="signature-file"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            {uploadUrl ? <img className="sign-upload" src={uploadUrl} alt="Signature preview" /> : null}
            <div className="row-actions">
              <button type="button" className="btn primary" data-testid="signature-use" onClick={useUpload} disabled={!uploadUrl}>
                Use this signature
              </button>
            </div>
          </div>
        ) : null}

        <button type="button" className="btn ghost close-modal" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function hebrew(text: string): boolean {
  return /[\u0590-\u05FF]/.test(text)
}

function renderTyped(name: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 1100
  canvas.height = 320
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const rtl = hebrew(name)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#1a1714'
  ctx.direction = rtl ? 'rtl' : 'ltr'
  ctx.textAlign = rtl ? 'right' : 'left'
  ctx.textBaseline = 'middle'
  ctx.font = rtl ? '700 140px "Noto Sans Hebrew"' : '170px "Great Vibes"'
  ctx.fillText(name, rtl ? canvas.width - 36 : 36, canvas.height / 2)
  return canvas
}

function trimCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = source.getContext('2d')
  if (!ctx) return source
  const { width, height } = source
  const data = ctx.getImageData(0, 0, width, height).data
  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3] ?? 0
      if (alpha < 12) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX) return source
  const pad = 12
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(width - 1, maxX + pad)
  maxY = Math.min(height - 1, maxY + pad)
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  out.getContext('2d')?.drawImage(source, minX, minY, w, h, 0, 0, w, h)
  return out
}

async function fileToPng(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    const max = 1200
    const scale = Math.min(1, max / Math.max(image.width, image.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not read that image'))
    image.src = src
  })
}
