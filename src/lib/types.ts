export type Align = 'left' | 'center' | 'right' | 'auto'

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
  bold?: boolean
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
