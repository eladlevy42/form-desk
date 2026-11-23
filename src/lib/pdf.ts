import fontkit from '@pdf-lib/fontkit'
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  TextAlignment,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib'
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type PageViewport,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { hasHebrew, resolvedAlign, toVisual } from './bidi.ts'
import { fontMetrics, getScriptBytes } from './fonts.ts'
import { layoutLines, visualMeasure } from './layout.ts'
import { editDiffers, partCover } from './runs.ts'
import type { CoverItem, FontId, FormField, ImageItem, MarkItem, PageInfo, SignatureItem, TextEdit, TextItem, TextRun } from './types.ts'

GlobalWorkerOptions.workerSrc = workerUrl

function asset(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`
}

export function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({
    data: bytes.slice(),
    standardFontDataUrl: asset('standard_fonts/'),
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    wasmUrl: asset('wasm/'),
  }).promise
}

type RawOption = { displayValue?: string; exportValue?: string }
type RawAnn = {
  subtype?: string
  fieldType?: string
  fieldName?: string
  fieldValue?: string
  checkBox?: boolean
  radioButton?: boolean
  pushButton?: boolean
  readOnly?: boolean
  multiline?: boolean
  exportValue?: string
  buttonValue?: string
  defaultAppearance?: string
  rect?: number[]
  options?: RawOption[]
}

export async function readPagesAndFields(
  pdf: PDFDocumentProxy,
): Promise<{ pages: PageInfo[]; fields: FormField[] }> {
  const pages: PageInfo[] = []
  const fields: FormField[] = []
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    pages.push({ width: viewport.width, height: viewport.height })
    let annotations: RawAnn[] = []
    try {
      annotations = (await page.getAnnotations()) as RawAnn[]
    } catch {
      annotations = []
    }
    annotations.forEach((ann, index) => {
      const field = toField(ann, i - 1, index, viewport)
      if (field) fields.push(field)
    })
  }
  return { pages, fields }
}

function fontSizeFromAppearance(appearance: string | undefined, height: number): number {
  const match = appearance ? /([\d.]+)\s+Tf/.exec(appearance) : null
  const parsed = match ? Number(match[1]) : 0
  if (parsed > 1) return parsed
  return Math.max(8, Math.min(16, height * 0.7))
}

function toField(
  ann: RawAnn,
  pageIndex: number,
  index: number,
  viewport: PageViewport,
): FormField | null {
  if (ann.subtype !== 'Widget' || !ann.fieldName || !ann.rect || ann.rect.length < 4) return null
  if (ann.pushButton || ann.fieldType === 'Sig') return null
  const [x1, y1] = viewport.convertToViewportPoint(ann.rect[0] ?? 0, ann.rect[1] ?? 0) as number[]
  const [x2, y2] = viewport.convertToViewportPoint(ann.rect[2] ?? 0, ann.rect[3] ?? 0) as number[]
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const width = Math.abs(x2 - x1)
  const height = Math.abs(y2 - y1)
  if (width < 2 || height < 2) return null
  const shared = {
    id: `${ann.fieldName}:${pageIndex}:${index}`,
    name: ann.fieldName,
    page: pageIndex,
    x,
    y,
    width,
    height,
    multiline: Boolean(ann.multiline),
    readOnly: Boolean(ann.readOnly),
    fontSize: fontSizeFromAppearance(ann.defaultAppearance, height),
  }
  if (ann.fieldType === 'Tx') {
    return { ...shared, kind: 'text', initial: ann.fieldValue ?? '' }
  }
  if (ann.fieldType === 'Btn' && ann.checkBox) {
    const checked = Boolean(ann.fieldValue && ann.fieldValue !== 'Off')
    return { ...shared, kind: 'checkbox', initial: checked }
  }
  if (ann.fieldType === 'Btn' && ann.radioButton) {
    const radioValue = ann.buttonValue || ann.exportValue || 'Yes'
    return {
      ...shared,
      kind: 'radio',
      radioValue,
      initial: ann.fieldValue === radioValue ? radioValue : '',
    }
  }
  if (ann.fieldType === 'Ch') {
    const options = (ann.options ?? [])
      .map((opt) => ({
        label: opt.displayValue || opt.exportValue || '',
        value: opt.exportValue || opt.displayValue || '',
      }))
      .filter((opt) => opt.value)
    return { ...shared, kind: 'choice', options, initial: ann.fieldValue ?? '' }
  }
  return null
}

export function initialValues(fields: FormField[]): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {}
  for (const field of fields) {
    if (field.kind === 'checkbox') {
      values[field.name] = Boolean(field.initial)
      continue
    }
    if (field.kind === 'radio') {
      if (typeof field.initial === 'string' && field.initial) values[field.name] = field.initial
      else if (!(field.name in values)) values[field.name] = ''
      continue
    }
    values[field.name] = typeof field.initial === 'string' ? field.initial : ''
  }
  return values
}

function parseColor(hex: string): RGB {
  const raw = hex.replace('#', '').trim()
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  const n = Number.parseInt(full, 16)
  if (!Number.isFinite(n) || full.length !== 6) return rgb(0.1, 0.09, 0.08)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

function keepSupportedChars(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code === 0x09 || code === 0x0a || code === 0x20 || (code >= 0x21 && code <= 0x7e) || (code >= 0x0590 && code <= 0x05ff)
    })
    .join('')
}

function axisAngle(viewport: PageViewport): number {
  const [x0, y0] = viewport.convertToPdfPoint(0, 0) as number[]
  const [x1, y1] = viewport.convertToPdfPoint(1, 0) as number[]
  return (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? ''
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export type ExportResult = {
  bytes: Uint8Array
  warning?: string
}

export async function exportPdf(input: {
  pdfBytes: Uint8Array
  fontBytes: Uint8Array
  texts: TextItem[]
  signatures: SignatureItem[]
  covers: CoverItem[]
  runs: TextRun[]
  edits: TextEdit[]
  marks: MarkItem[]
  images: ImageItem[]
  values: Record<string, string | boolean>
}): Promise<ExportResult> {
  const warnings: string[] = []
  const src = await openPdf(input.pdfBytes)
  const viewports: PageViewport[] = []
  for (let i = 1; i <= src.numPages; i += 1) {
    const page = await src.getPage(i)
    viewports.push(page.getViewport({ scale: 1 }))
  }

  const pdfDoc = await PDFDocument.load(input.pdfBytes.slice())
  pdfDoc.registerFontkit(fontkit as never)
  const font = await pdfDoc.embedFont(input.fontBytes, { subset: true })
  let script: PDFFont | null = null
  const scriptBytes = getScriptBytes()
  const fontFor = async (choice: FontId | undefined, text: string): Promise<PDFFont> => {
    if (choice === 'script' && scriptBytes && !hasHebrew(text)) {
      if (!script) script = await pdfDoc.embedFont(scriptBytes, { subset: true })
      return script
    }
    return font
  }

  try {
    fillForm(pdfDoc, font, input.values, warnings)
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : 'Could not write form fields')
  }

  const lineFactor = fontMetrics().ascent + fontMetrics().descent
  for (const cover of input.covers) {
    const page = pdfDoc.getPage(cover.page)
    const viewport = viewports[cover.page]
    if (!page || !viewport) continue
    drawBox(page, viewport, cover, rgb(1, 1, 1))
  }

  // Original text is stored as custom glyph IDs, so rewriting the content
  // stream is not reliable. Cover the exact glyph box with the sampled
  // background, then draw the replacement in the same place.
  for (const edit of input.edits) {
    const run = input.runs.find((item) => item.id === edit.runId)
    const page = pdfDoc.getPage(edit.page)
    const viewport = viewports[edit.page]
    if (!run || !page || !viewport || !editDiffers(edit, run)) continue
    for (const part of run.parts.length ? run.parts : [{ x: run.x, baseline: run.baseline, width: run.width, text: run.text, fontSize: run.fontSize, ascent: run.ascent, descent: run.descent }]) {
      drawBox(page, viewport, partCover(part), parseColor(run.background))
    }
  }

  for (const item of input.texts) {
    const page = pdfDoc.getPage(item.page)
    const viewport = viewports[item.page]
    if (!page || !viewport || !item.text) continue
    const safe = keepSupportedChars(item.text)
    if (safe !== item.text) warnings.push('Some characters were skipped. The embedded font covers English and Hebrew.')
    const face = await fontFor(item.font, safe)
    drawTextItem(page, viewport, { ...item, text: safe }, face, lineFactor, warnings)
  }

  for (const edit of input.edits) {
    const run = input.runs.find((item) => item.id === edit.runId)
    const page = pdfDoc.getPage(edit.page)
    const viewport = viewports[edit.page]
    if (!run || !page || !viewport || edit.deleted || !edit.text.trim() || !editDiffers(edit, run)) continue
    const safe = keepSupportedChars(edit.text)
    if (safe !== edit.text) warnings.push('Some characters were skipped. The embedded font covers English and Hebrew.')
    const face = await fontFor(edit.font, safe)
    drawTextItem(
      page,
      viewport,
      {
        id: edit.id,
        page: edit.page,
        x: edit.x,
        y: edit.baseline,
        text: safe,
        fontSize: edit.fontSize,
        color: edit.color,
        align: edit.align ?? (hasHebrew(safe) || run.dir === 'rtl' ? 'auto' : 'left'),
        boxWidth: edit.boxWidth || run.width,
        boxHeight: edit.boxHeight || (run.ascent + run.descent) * run.fontSize,
        bold: edit.bold,
        font: edit.font,
        underline: edit.underline,
        background: edit.background,
      },
      face,
      lineFactor,
      warnings,
    )
  }

  for (const mark of input.marks) {
    const page = pdfDoc.getPage(mark.page)
    const viewport = viewports[mark.page]
    if (!page || !viewport) continue
    drawMark(page, viewport, mark, font, warnings)
  }

  for (const image of input.images) {
    const page = pdfDoc.getPage(image.page)
    const viewport = viewports[image.page]
    if (!page || !viewport || image.width < 2 || image.height < 2) continue
    try {
      const bytes = dataUrlBytes(image.dataUrl)
      const embedded = image.dataUrl.startsWith('data:image/jpeg') || image.dataUrl.startsWith('data:image/jpg')
        ? await pdfDoc.embedJpg(bytes)
        : await pdfDoc.embedPng(bytes)
      const [x, y] = viewport.convertToPdfPoint(image.x, image.y + image.height) as number[]
      page.drawImage(embedded, { x, y, width: image.width, height: image.height })
    } catch {
      warnings.push('An image could not be embedded.')
    }
  }

  for (const sig of input.signatures) {
    const page = pdfDoc.getPage(sig.page)
    const viewport = viewports[sig.page]
    if (!page || !viewport || sig.width < 2 || sig.height < 2) continue
    try {
      const image = await pdfDoc.embedPng(dataUrlBytes(sig.dataUrl))
      const [x, y] = viewport.convertToPdfPoint(sig.x, sig.y + sig.height) as number[]
      const angle = axisAngle(viewport)
      page.drawImage(image, {
        x,
        y,
        width: sig.width,
        height: sig.height,
        rotate: Math.abs(angle) > 0.2 ? degrees(angle) : undefined,
      })
    } catch {
      warnings.push('A signature could not be embedded.')
    }
  }

  await src.cleanup()
  const bytes = await pdfDoc.save()
  return { bytes, warning: warnings.length ? [...new Set(warnings)].join(' ') : undefined }
}

function drawBox(
  page: PDFPage,
  viewport: PageViewport,
  box: { x: number; y: number; width: number; height: number },
  color: RGB,
): void {
  const [x, y] = viewport.convertToPdfPoint(box.x, box.y + box.height) as number[]
  const angle = axisAngle(viewport)
  page.drawRectangle({
    x,
    y,
    width: box.width,
    height: box.height,
    color,
    rotate: Math.abs(angle) > 0.2 ? degrees(angle) : undefined,
  })
}

function drawTextItem(
  page: PDFPage,
  viewport: PageViewport,
  item: TextItem,
  font: PDFFont,
  lineFactor: number,
  warnings: string[],
): void {
  const angle = axisAngle(viewport)
  const lineHeight = item.fontSize * lineFactor
  const fixedHeight = item.boxHeight && item.boxHeight > 0 ? item.boxHeight : 0
  const maxLines = fixedHeight ? Math.max(1, Math.floor((fixedHeight + 0.4) / lineHeight)) : 0
  let lines: string[] = [item.text]
  try {
    const measure = visualMeasure((value) => font.widthOfTextAtSize(value, item.fontSize))
    lines = layoutLines(item.text, item.boxWidth, maxLines, measure)
  } catch {
    warnings.push('A line of text could not be measured.')
    lines = item.text.split('\n').slice(0, maxLines)
  }
  if (item.background) {
    const shown = Math.max(1, lines.length) * lineHeight
    drawBox(
      page,
      viewport,
      {
        x: item.x,
        y: item.y - item.fontSize * fontMetrics().ascent,
        width: item.boxWidth,
        height: fixedHeight || shown,
      },
      parseColor(item.background),
    )
  }
  lines.forEach((line, index) => {
    const visual = toVisual(line)
    if (!visual.trim()) return
    let width = 0
    try {
      width = font.widthOfTextAtSize(visual, item.fontSize)
    } catch {
      warnings.push('A line of text could not be measured.')
      return
    }
    const align = resolvedAlign(item.align, line)
    let vx = item.x
    if (align === 'center') vx = item.x + Math.max(0, item.boxWidth - width) / 2
    if (align === 'right') vx = item.x + Math.max(0, item.boxWidth - width)
    const baseline = item.y + index * lineHeight
    const [x, y] = viewport.convertToPdfPoint(vx, baseline) as number[]
    const paint = {
      y,
      size: item.fontSize,
      font,
      color: parseColor(item.color),
      rotate: Math.abs(angle) > 0.2 ? degrees(angle) : undefined,
    }
    try {
      page.drawText(visual, { ...paint, x })
      if (item.bold) {
        const shift = Math.max(0.25, item.fontSize * 0.03)
        page.drawText(visual, { ...paint, x: x + shift })
      }
      if (item.underline) {
        const [ux, uy] = viewport.convertToPdfPoint(vx, baseline + item.fontSize * 0.12) as number[]
        page.drawLine({
          start: { x: ux, y: uy },
          end: { x: ux + width, y: uy },
          thickness: Math.max(0.6, item.fontSize * 0.05),
          color: parseColor(item.color),
        })
      }
    } catch {
      warnings.push('A line of text could not be written into the PDF.')
    }
  })
}

function drawMark(page: PDFPage, viewport: PageViewport, mark: MarkItem, font: PDFFont, warnings: string[]): void {
  const color = parseColor(mark.color || '#1a1714')
  if (mark.kind === 'highlight') {
    const [x, y] = viewport.convertToPdfPoint(mark.x, mark.y + mark.height) as number[]
    page.drawRectangle({ x, y, width: mark.width, height: mark.height, color: rgb(1, 0.86, 0.2), opacity: 0.45 })
    return
  }
  if (mark.kind === 'line') {
    const [x1, y1] = viewport.convertToPdfPoint(mark.x, mark.y) as number[]
    const [x2, y2] = viewport.convertToPdfPoint(mark.x + mark.width, mark.y + mark.height) as number[]
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1.4, color })
    return
  }
  if (mark.kind === 'check' || mark.kind === 'cross') {
    const [x1, y1] = viewport.convertToPdfPoint(mark.x, mark.y + mark.height) as number[]
    const [x2, y2] = viewport.convertToPdfPoint(mark.x + mark.width, mark.y) as number[]
    const [x3, y3] = viewport.convertToPdfPoint(mark.x + mark.width, mark.y + mark.height) as number[]
    const [x4, y4] = viewport.convertToPdfPoint(mark.x, mark.y) as number[]
    if (mark.kind === 'cross') {
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1.6, color })
      page.drawLine({ start: { x: x3, y: y3 }, end: { x: x4, y: y4 }, thickness: 1.6, color })
    } else {
      const midX = mark.x + mark.width * 0.35
      const midY = mark.y + mark.height * 0.62
      const [mx, my] = viewport.convertToPdfPoint(midX, midY) as number[]
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: mx, y: my }, thickness: 1.8, color })
      page.drawLine({ start: { x: mx, y: my }, end: { x: x2, y: y2 }, thickness: 1.8, color })
    }
    return
  }
  if (mark.kind === 'date' && mark.text) {
    try {
      const [x, y] = viewport.convertToPdfPoint(mark.x, mark.y + mark.height * 0.75) as number[]
      page.drawText(mark.text, { x, y, size: 11, font, color })
    } catch {
      warnings.push('The date stamp could not be written.')
    }
  }
}

function fillForm(
  pdfDoc: PDFDocument,
  font: PDFFont,
  values: Record<string, string | boolean>,
  warnings: string[],
): void {
  const form = pdfDoc.getForm()
  const fields = form.getFields()
  if (fields.length === 0) return
  let touched = false
  for (const field of fields) {
    const name = field.getName()
    if (!(name in values)) continue
    const value = values[name]
    try {
      if (field instanceof PDFTextField) {
        const logical = keepSupportedChars(String(value ?? ''))
        const visual = toVisual(logical)
        field.setAlignment(hasHebrew(logical) ? TextAlignment.Right : TextAlignment.Left)
        field.setText(visual)
        field.updateAppearances(font)
        touched = true
      } else if (field instanceof PDFCheckBox) {
        if (value) field.check()
        else field.uncheck()
        touched = true
      } else if (field instanceof PDFRadioGroup) {
        if (typeof value === 'string' && value) field.select(value)
        touched = true
      } else if (field instanceof PDFDropdown) {
        if (typeof value === 'string' && value) field.select(value)
        touched = true
      } else if (field instanceof PDFOptionList) {
        if (typeof value === 'string' && value) field.select(value)
        touched = true
      }
    } catch (err) {
      warnings.push(
        err instanceof Error ? `Field “${name}”: ${err.message}` : `Could not fill “${name}”.`,
      )
    }
  }
  if (touched) form.flatten({ updateFieldAppearances: false })
}
