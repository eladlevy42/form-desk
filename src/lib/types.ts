export type Align = 'left' | 'center' | 'right' | 'auto'
export type FontId = 'noto' | 'script'

export type TextItem = {
  id: string
  page: number
  x: number
  y: number
  text: string
  fontSize: number
  color: string
  align: Align
  boxWidth: number
  /** Set when the user resizes the box. Unset boxes grow with explicit line breaks. */
  boxHeight?: number
  bold?: boolean
  font?: FontId
  underline?: boolean
  /** Highlight behind the box. Empty means none. */
  background?: string
}

/** One PDF.js glyph run before same-line fragments are merged. */
export type TextPart = {
  x: number
  baseline: number
  width: number
  text: string
  fontSize: number
  ascent: number
  descent: number
}

/** A run of existing PDF text, in viewport space (origin top-left, scale 1). */
export type TextRun = {
  id: string
  page: number
  x: number
  baseline: number
  width: number
  fontSize: number
  color: string
  background: string
  text: string
  dir: 'ltr' | 'rtl'
  ascent: number
  descent: number
  bold: boolean
  /** Original fragments. A time like 06:00 may be several parts with tiny gaps. */
  parts: TextPart[]
}

/** An in-place change to a TextRun. The original glyphs are covered on export. */
export type TextEdit = {
  id: string
  runId: string
  page: number
  x: number
  baseline: number
  text: string
  fontSize: number
  color: string
  bold: boolean
  deleted: boolean
  boxWidth: number
  boxHeight: number
  align: Align
  font?: FontId
  underline?: boolean
  background?: string
}

export type MarkKind = 'highlight' | 'line' | 'check' | 'cross' | 'date'

export type MarkItem = {
  id: string
  page: number
  kind: MarkKind
  x: number
  y: number
  width: number
  height: number
  color: string
  text?: string
}

export type ImageItem = {
  id: string
  page: number
  x: number
  y: number
  width: number
  height: number
  dataUrl: string
}

export type SignatureItem = {
  id: string
  page: number
  x: number
  y: number
  width: number
  height: number
  dataUrl: string
}

export type CoverItem = {
  id: string
  page: number
  x: number
  y: number
  width: number
  height: number
}

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'choice'

export type FormField = {
  id: string
  name: string
  page: number
  kind: FieldKind
  x: number
  y: number
  width: number
  height: number
  multiline: boolean
  readOnly: boolean
  fontSize: number
  options?: { label: string; value: string }[]
  radioValue?: string
  initial: string | boolean
}

export type PageInfo = {
  width: number
  height: number
}

export type DocState = {
  fileName: string
  pdfBytes: Uint8Array
  pages: PageInfo[]
  fields: FormField[]
  texts: TextItem[]
  signatures: SignatureItem[]
  covers: CoverItem[]
  runs: TextRun[]
  edits: TextEdit[]
  marks: MarkItem[]
  images: ImageItem[]
  values: Record<string, string | boolean>
  pageIndex: number
  zoom: number
  fontSize: number
  color: string
  cellWidth: number
  rowHeight: number
  align: Align
}

export type SessionV1 = {
  version: 1
  savedAt: number
  fileName: string
  pdf: ArrayBuffer
  texts: TextItem[]
  signatures: SignatureItem[]
  covers: CoverItem[]
  edits?: TextEdit[]
  marks?: MarkItem[]
  images?: ImageItem[]
  docId?: string
  values: Record<string, string | boolean>
  pageIndex: number
  zoom: number
  fontSize: number
  color: string
  cellWidth: number
  rowHeight: number
  align: Align
}

export const SAMPLE_NAME = 'sample-time-report.pdf'
