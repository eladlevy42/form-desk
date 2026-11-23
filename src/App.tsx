import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { BoxFrame } from './BoxFrame.tsx'
import { SignatureDialog } from './SignatureDialog.tsx'
import { hasHebrew, resolvedAlign } from './lib/bidi.ts'
import { ensureFonts, fontMetrics, getFontBytes, measureTextWidth } from './lib/fonts.ts'
import { layoutLines, type Guide, type Rect } from './lib/layout.ts'
import { appendPdf, deletePdfPage, insertBlankPage, movePdfPage, pageMapDelete, pageMapInsert, pageMapMove, remapPage, rotateBox90, rotatePdfPage } from './lib/pages.ts'
import { exportPdf, initialValues, openPdf, readPagesAndFields } from './lib/pdf.ts'
import { combineRuns, editDiffers, extractRuns, partCover, runCoverBox, splitRun, splitRunText } from './lib/runs.ts'
import { bytesFromSession, clearSession, listDocs, loadNamedDoc, loadSession, saveNamedDoc, saveSession, saveSessionNow, type DocSummary } from './lib/storage.ts'
import {
  SAMPLE_NAME,
  type Align,
  type CoverItem,
  type DocState,
  type FontId,
  type FormField,
  type ImageItem,
  type MarkItem,
  type MarkKind,
  type SessionV1,
  type SignatureItem,
  type TextEdit,
  type TextItem,
  type TextRun,
} from './lib/types.ts'

const CLICK_BIAS = 0.3

type Tool = 'text' | 'whiteout' | 'edit' | 'highlight' | 'line' | 'check' | 'cross' | 'date' | 'highlight' | 'line' | 'check' | 'cross' | 'date'
type PendingFile = { bytes: Uint8Array; name: string }
type SigDraft = { dataUrl: string; aspect: number }
type Snap = Pick<DocState, 'texts' | 'signatures' | 'covers' | 'values' | 'edits' | 'marks' | 'images' | 'runs'>

export default function App() {
  const [boot, setBoot] = useState<'loading' | 'ready'>('loading')
  const [doc, setDoc] = useState<DocState | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('text')
  const [focusId, setFocusId] = useState<string | null>(null)
  const [editFocus, setEditFocus] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [guides, setGuides] = useState<Guide[]>([])
  const [recent, setRecent] = useState<DocSummary[]>([])
  const [findQuery, setFindQuery] = useState('')
  const [replaceWith, setReplaceWith] = useState('')
  const [pendingImage, setPendingImage] = useState<SigDraft | null>(null)
  const docId = useRef('')
  const imageRef = useRef<HTMLInputElement>(null)
  const mergeRef = useRef<HTMLInputElement>(null)
  const [selectedSig, setSelectedSig] = useState<string | null>(null)
  const [selectedCover, setSelectedCover] = useState<string | null>(null)
  const [pendingSig, setPendingSig] = useState<SigDraft | null>(null)
  const [signOpen, setSignOpen] = useState(false)
  const [confirmFresh, setConfirmFresh] = useState(false)
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null)
  const [frameWidth, setFrameWidth] = useState(960)
  const [thumbs, setThumbs] = useState<string[]>([])
  const [hist, setHist] = useState({ undo: 0, redo: 0 })
  const [draftCover, setDraftCover] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const coverOrigin = useRef<{ x: number; y: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [fontsReady, setFontsReady] = useState(false)

  const docRef = useRef<DocState | null>(null)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const past = useRef<Snap[]>([])
  const future = useRef<Snap[]>([])
  const gesture = useRef(false)
  const generation = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const persistRef = useRef<() => void>(() => {})

  useEffect(() => {
    docRef.current = doc
  }, [doc])

  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        await ensureFonts()
        if (!cancel) setFontsReady(true)
        const [session, docs] = await Promise.all([loadSession(), listDocs().catch(() => [])])
        if (!cancel) setRecent(docs)
        if (cancel) return
        if (session) {
          await openBytes(bytesFromSession(session), session.fileName, session, true)
          if (!cancel) {
            setSavedAt(session.savedAt)
            setRestored(true)
          }
        }
      } catch (err) {
        if (!cancel) setStatus(err instanceof Error ? err.message : 'Could not restore the saved form')
      } finally {
        if (!cancel) setBoot('ready')
      }
    })()
    return () => {
      cancel = true
    }
    // openBytes is stable enough for the first load: it only uses refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const update = () => setFrameWidth(el.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [doc])

  useEffect(() => {
    if (!doc) return
    const timer = window.setTimeout(() => persistRef.current(), 400)
    return () => window.clearTimeout(timer)
  }, [doc])

  useEffect(() => {
    const tick = window.setInterval(() => persistRef.current(), 60_000)
    const leave = () => {
      const current = docRef.current
      if (current) saveSessionNow(current)
    }
    window.addEventListener('pagehide', leave)
    window.addEventListener('beforeunload', leave)
    return () => {
      window.clearInterval(tick)
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('beforeunload', leave)
    }
  }, [])

  useEffect(() => {
    return () => {
      void pdfRef.current?.cleanup()
    }
  }, [])

  const pdfBytes = doc?.pdfBytes
  useEffect(() => {
    if (!pdfBytes) {
      setThumbs([])
      return
    }
    let cancel = false
    let extra: PDFDocumentProxy | null = null
    ;(async () => {
      try {
        extra = await openPdf(pdfBytes)
        if (cancel) {
          await extra.cleanup()
          return
        }
        const urls: string[] = []
        for (let i = 1; i <= extra.numPages; i += 1) {
          const page = await extra.getPage(i)
          const viewport = page.getViewport({ scale: 0.15 })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          await page.render({ canvas, viewport }).promise
          urls.push(canvas.toDataURL('image/jpeg', 0.72))
          if (cancel) return
        }
        if (!cancel) setThumbs(urls)
      } catch {
        if (!cancel) setThumbs([])
      } finally {
        await extra?.cleanup()
      }
    })()
    return () => {
      cancel = true
    }
  }, [pdfBytes])

  async function persist() {
    const current = docRef.current
    if (!current) return
    setSaving(true)
    try {
      const at = await saveSession(current)
      if (!docId.current) docId.current = `doc-${Date.now()}`
      await saveNamedDoc(docId.current, current, at)
      setRecent(await listDocs())
      setSavedAt(at)
      setSaveError(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save in this browser')
    } finally {
      setSaving(false)
    }
  }
  persistRef.current = () => {
    void persist()
  }

  function publish(next: DocState | null) {
    docRef.current = next
    setDoc(next)
  }

  function remember() {
    const current = docRef.current
    if (!current) return
    past.current.push(takeSnap(current))
    if (past.current.length > 80) past.current.shift()
    future.current = []
    setHist({ undo: past.current.length, redo: 0 })
  }

  function apply(recipe: (current: DocState) => DocState) {
    const current = docRef.current
    if (!current) return
    publish(recipe(current))
  }

  function undo() {
    gesture.current = false
    const current = docRef.current
    const prev = past.current.pop()
    if (!current || !prev) return
    future.current.push(takeSnap(current))
    publish({ ...current, ...prev })
    setHist({ undo: past.current.length, redo: future.current.length })
  }

  function redo() {
    gesture.current = false
    const current = docRef.current
    const next = future.current.pop()
    if (!current || !next) return
    past.current.push(takeSnap(current))
    publish({ ...current, ...next })
    setHist({ undo: past.current.length, redo: future.current.length })
  }

  async function openBytes(
    bytes: Uint8Array,
    fileName: string,
    restored: SessionV1 | null,
    fromSession: boolean,
  ) {
    const token = ++generation.current
    const copy = bytes.slice()
    const loaded = await openPdf(copy)
    if (token !== generation.current) {
      await loaded.cleanup()
      return
    }
    const { pages, fields } = await readPagesAndFields(loaded)
    const runs = await extractRuns(loaded)
    if (token !== generation.current) {
      await loaded.cleanup()
      return
    }
    if (pdfRef.current) await pdfRef.current.cleanup()
    pdfRef.current = loaded
    setPdf(loaded)
    const preset = fileName === SAMPLE_NAME
    const rowHeight = restored?.rowHeight ?? (preset ? 26 : 18)
    const next: DocState = {
      fileName,
      pdfBytes: copy,
      pages,
      fields,
      texts: restored?.texts ?? [],
      signatures: restored?.signatures ?? [],
      covers: restored?.covers ?? [],
      runs,
      edits: (restored?.edits ?? []).filter((edit) => runs.some((run) => run.id === edit.runId)),
      marks: restored?.marks ?? [],
      images: restored?.images ?? [],
      values: { ...initialValues(fields), ...(restored?.values ?? {}) },
      pageIndex: clamp(restored?.pageIndex ?? 0, 0, Math.max(0, pages.length - 1)),
      zoom: restored?.zoom ?? guessZoom(pages[0]?.width ?? 595, rowHeight),
      fontSize: restored?.fontSize ?? 11,
      color: restored?.color ?? '#1a1714',
      cellWidth: restored?.cellWidth ?? (preset ? 58 : 72),
      rowHeight,
      align: restored?.align ?? 'auto',
    }
    past.current = []
    future.current = []
    gesture.current = false
    setHist({ undo: 0, redo: 0 })
    setFocusId(null)
    setEditFocus(null)
    setSelectedSig(null)
    setSelectedCover(null)
    setPendingSig(null)
    setTool('text')
    setStatus(null)
    setPicked([])
    setRestored(fromSession)
    docId.current = restored?.docId || `${fileName}-${Date.now()}`
    publish(next)
  }

  async function acceptFile(bytes: Uint8Array, name: string) {
    const head = String.fromCharCode(...bytes.slice(0, 4))
    if (head !== '%PDF') {
      setStatus('That file is not a PDF.')
      return
    }
    if (docRef.current && (docRef.current.texts.length || docRef.current.signatures.length || docRef.current.edits.length || docRef.current.covers.length)) {
      setPendingFile({ bytes, name })
      return
    }
    await openBytes(bytes, name, null, false)
  }

  async function onPick(file: File | undefined) {
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    await acceptFile(bytes, file.name)
  }

  async function openSample() {
    const res = await fetch(`${import.meta.env.BASE_URL}${SAMPLE_NAME}`)
    if (!res.ok) {
      setStatus('The sample time report is missing from this build.')
      return
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    await acceptFile(bytes, SAMPLE_NAME)
  }

  async function download() {
    const current = docRef.current
    const fontBytes = getFontBytes()
    if (!current || !fontBytes) {
      setStatus('The Hebrew font is still loading. Try the download again in a moment.')
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const result = await exportPdf({
        pdfBytes: current.pdfBytes,
        fontBytes,
        texts: current.texts,
        signatures: current.signatures,
        covers: current.covers,
        runs: current.runs,
        edits: current.edits,
        marks: current.marks,
        images: current.images,
        values: current.values,
      })
      const copy = new Uint8Array(result.bytes)
      const blob = new Blob([copy], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = current.fileName.replace(/\.pdf$/i, '') + '-filled.pdf'
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 2000)
      if (result.warning) setStatus(result.warning)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not build the PDF')
    } finally {
      setBusy(false)
    }
  }

  async function startFresh() {
    generation.current += 1
    if (pdfRef.current) await pdfRef.current.cleanup()
    pdfRef.current = null
    setPdf(null)
    publish(null)
    setSavedAt(null)
    setRestored(false)
    setFocusId(null)
    setEditFocus(null)
    setPendingSig(null)
    setStatus(null)
    setThumbs([])
    past.current = []
    future.current = []
    setHist({ undo: 0, redo: 0 })
    try {
      await clearSession()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not clear the saved copy')
    }
    setConfirmFresh(false)
  }

  function eventPoint(event: { clientX: number; clientY: number }) {
    const sheet = sheetRef.current
    const current = docRef.current
    if (!sheet || !current) return { x: 0, y: 0 }
    const rect = sheet.getBoundingClientRect()
    const page = current.pages[current.pageIndex]
    const scaleX = page ? rect.width / page.width : 1
    const scaleY = page ? rect.height / page.height : 1
    return {
      x: (event.clientX - rect.left) / scaleX,
      y: (event.clientY - rect.top) / scaleY,
    }
  }

  function boxesExcept(selfId: string): Rect[] {
    const current = docRef.current
    if (!current) return []
    const rects: Rect[] = []
    const metricsNow = fontMetrics()
    for (const text of current.texts) {
      if (text.id === selfId || text.page !== current.pageIndex) continue
      const h = text.boxHeight ?? text.fontSize * (metricsNow.ascent + metricsNow.descent)
      rects.push({ x: text.x, y: text.y - text.fontSize * metricsNow.ascent, w: text.boxWidth, h })
    }
    for (const edit of current.edits) {
      if (edit.id === selfId || edit.deleted || edit.page !== current.pageIndex) continue
      rects.push({
        x: edit.x,
        y: edit.baseline - edit.fontSize * metricsNow.ascent,
        w: edit.boxWidth || 40,
        h: edit.boxHeight || edit.fontSize,
      })
    }
    for (const run of current.runs) {
      if (run.page !== current.pageIndex || run.id === selfId) continue
      const box = runCoverBox(run)
      rects.push({ x: box.x, y: box.y, w: box.width, h: box.height })
    }
    return rects
  }

  function snapPoint(x: number, y: number): { x: number; y: number } {
    const current = docRef.current
    if (!current) return { x, y }
    let sx = x
    let sy = y
    for (const item of current.texts) {
      if (item.page !== current.pageIndex) continue
      if (Math.abs(item.x - x) <= 5) sx = item.x
      if (Math.abs(item.y - y) <= 5) sy = item.y
    }
    return { x: sx, y: sy }
  }

  function createText(x: number, y: number) {
    const current = docRef.current
    if (!current) return
    const snapped = snapPoint(x, y + current.fontSize * CLICK_BIAS)
    const id = uid()
    const item: TextItem = {
      id,
      page: current.pageIndex,
      x: snapped.x,
      y: snapped.y,
      text: '',
      fontSize: current.fontSize,
      color: current.color,
      align: current.align,
      boxWidth: current.cellWidth,
      font: 'noto',
    }
    gesture.current = false
    remember()
    apply((d) => ({ ...d, texts: [...d.texts, item] }))
    setFocusId(id)
    setEditFocus(null)
    setSelectedSig(null)
    setSelectedCover(null)
  }

  function beginEdit(run: TextRun) {
    const current = docRef.current
    if (!current) return
    const existing = current.edits.find((edit) => edit.runId === run.id)
    if (existing) {
      setEditFocus(existing.id)
      setFocusId(null)
      setSelectedSig(null)
      setSelectedCover(null)
      return
    }
    const edit: TextEdit = {
      id: uid(),
      runId: run.id,
      page: run.page,
      x: run.x,
      baseline: run.baseline,
      text: run.text,
      fontSize: run.fontSize,
      color: run.color,
      bold: run.bold,
      deleted: false,
      boxWidth: Math.max(run.width, 28),
      boxHeight: (run.ascent + run.descent) * run.fontSize,
      align: 'auto',
      font: 'noto',
    }
    gesture.current = false
    remember()
    apply((d) => ({ ...d, edits: [...d.edits, edit] }))
    setEditFocus(edit.id)
    setFocusId(null)
    setSelectedSig(null)
    setSelectedCover(null)
  }

  function updateEdit(id: string, patch: Partial<TextEdit>, live: boolean) {
    if (live) {
      if (!gesture.current) {
        remember()
        gesture.current = true
      }
    } else {
      gesture.current = false
    }
    if (Object.keys(patch).length === 0) return
    apply((d) => ({
      ...d,
      edits: d.edits.map((edit) => (edit.id === id ? { ...edit, ...patch } : edit)),
    }))
  }

  function deleteEdit(id: string) {
    const current = docRef.current
    const edit = current?.edits.find((item) => item.id === id)
    if (!edit) return
    gesture.current = false
    remember()
    if (edit.deleted) {
      const run = current?.runs.find((item) => item.id === edit.runId)
      apply((d) => ({
        ...d,
        edits: d.edits.map((item) =>
          item.id === id
            ? { ...item, deleted: false, text: run?.text ?? item.text, x: run?.x ?? item.x, baseline: run?.baseline ?? item.baseline }
            : item,
        ),
      }))
      return
    }
    apply((d) => ({
      ...d,
      edits: d.edits.map((item) => (item.id === id ? { ...item, deleted: true, text: '' } : item)),
    }))
  }

  function activeRunId(current: DocState): string | null {
    const edit = current.edits.find((item) => item.id === editFocus)
    if (edit) return edit.runId
    return picked.length === 1 ? picked[0] : null
  }

  function mergePicked() {
    const current = docRef.current
    if (!current || picked.length < 2) return
    const chosen = current.runs.filter((run) => picked.includes(run.id))
    if (chosen.length < 2) return
    const merged = combineRuns(chosen)
    const ids = new Set(chosen.map((run) => run.id))
    gesture.current = false
    remember()
    apply((d) => ({
      ...d,
      runs: [...d.runs.filter((run) => !ids.has(run.id)), merged],
      edits: d.edits.filter((edit) => !ids.has(edit.runId)),
    }))
    setPicked([merged.id])
    setStatus(null)
  }

  function splitFocused() {
    const current = docRef.current
    if (!current) return
    const run = current.runs.find((item) => item.id === activeRunId(current))
    if (!run) return
    const edit = current.edits.find((item) => item.runId === run.id)
    const text = edit?.text || run.text
    let at = Math.floor(text.length / 2)
    const field = document.querySelector<HTMLTextAreaElement>(`[data-edit-id="${edit?.id ?? ''}"]`)
    if (field && field.selectionStart > 0 && field.selectionStart < text.length) at = field.selectionStart
    const pieces = run.parts.length > 1 ? splitRun(run) : splitRunText({ ...run, text }, at)
    if (pieces.length < 2) return
    gesture.current = false
    remember()
    apply((d) => ({
      ...d,
      runs: [...d.runs.filter((item) => item.id !== run.id), ...pieces],
      edits: d.edits.filter((edit) => edit.runId !== run.id),
    }))
    setEditFocus(null)
    setPicked(pieces.map((item) => item.id))
  }

  function dropUnchangedEdits(keepId: string | null) {
    const current = docRef.current
    if (!current) return
    const stale = current.edits.filter((edit) => {
      if (edit.id === keepId) return false
      const run = current.runs.find((item) => item.id === edit.runId)
      return run ? !editDiffers(edit, run) : false
    })
    if (!stale.length) return
    apply((d) => ({ ...d, edits: d.edits.filter((edit) => !stale.some((item) => item.id === edit.id)) }))
  }

  function updateTextBox(id: string, patch: Partial<TextItem>, live: boolean) {
    if (live) {
      if (!gesture.current) {
        remember()
        gesture.current = true
      }
    } else {
      gesture.current = false
    }
    if (Object.keys(patch).length === 0) return
    apply((d) => ({
      ...d,
      texts: d.texts.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }))
  }

  function updateText(id: string, text: string, live: boolean) {
    if (live) {
      if (!gesture.current) {
        remember()
        gesture.current = true
      }
    }
    apply((d) => ({
      ...d,
      texts: d.texts.map((item) => (item.id === id ? { ...item, text } : item)),
    }))
  }

  function removeText(id: string) {
    gesture.current = false
    remember()
    apply((d) => ({ ...d, texts: d.texts.filter((item) => item.id !== id) }))
    setFocusId((current) => (current === id ? null : current))
  }

  function moveText(id: string, dx: number, dy: number) {
    if (!gesture.current) {
      remember()
      gesture.current = true
    }
    apply((d) => ({
      ...d,
      texts: d.texts.map((item) => (item.id === id ? { ...item, x: item.x + dx, y: item.y + dy } : item)),
    }))
  }

  function onTextKey(event: ReactKeyboardEvent<HTMLTextAreaElement>, item: TextItem) {
    if (event.nativeEvent.isComposing) return
    const current = docRef.current
    if (!current) return
    if (event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault()
      const step = event.shiftKey ? 4 : 1
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      moveText(item.id, dx, dy)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      gesture.current = false
      const dir = event.shiftKey ? -1 : 1
      const found = findText(current.texts, item, dir, 0, current.cellWidth, current.rowHeight)
      if (found) {
        setFocusId(found.id)
        return
      }
      const id = uid()
      const created: TextItem = {
        ...item,
        id,
        text: '',
        x: item.x + dir * current.cellWidth,
        fontSize: current.fontSize,
        color: current.color,
        align: current.align,
        boxWidth: current.cellWidth,
        boxHeight: item.boxHeight,
        font: item.font,
        underline: item.underline,
        background: item.background,
      }
      remember()
      apply((d) => ({ ...d, texts: [...d.texts, created] }))
      setFocusId(id)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      gesture.current = false
      const found = findText(current.texts, item, 0, 1, current.cellWidth, current.rowHeight)
      if (found) {
        setFocusId(found.id)
        return
      }
      const id = uid()
      const created: TextItem = {
        ...item,
        id,
        text: '',
        y: item.y + current.rowHeight,
        fontSize: current.fontSize,
        color: current.color,
        align: current.align,
        boxWidth: current.cellWidth,
      }
      remember()
      apply((d) => ({ ...d, texts: [...d.texts, created] }))
      setFocusId(id)
      return
    }
    if (event.key === 'Backspace' && item.text === '') {
      event.preventDefault()
      const previous =
        findText(current.texts, item, -1, 0, current.cellWidth, current.rowHeight) ??
        findText(current.texts, item, 0, -1, current.cellWidth, current.rowHeight)
      removeText(item.id)
      if (previous) setFocusId(previous.id)
    }
  }

  function onSheetClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (tool === 'whiteout' || tool === 'highlight' || tool === 'line') return
    if ((event.target as HTMLElement).closest('[data-overlay]')) return
    const pt = eventPoint(event)
    if (tool === 'check' || tool === 'cross' || tool === 'date') {
      placeMark(tool, pt.x, pt.y)
      return
    }
    if (tool === 'edit') {
      dropUnchangedEdits(null)
      setEditFocus(null)
      return
    }
    if (pendingSig) {
      const current = docRef.current
      if (!current) return
      const width = 170
      const height = width / Math.max(pendingSig.aspect, 0.2)
      const sig: SignatureItem = {
        id: uid(),
        page: current.pageIndex,
        x: pt.x,
        y: pt.y,
        width,
        height,
        dataUrl: pendingSig.dataUrl,
      }
      gesture.current = false
      remember()
      apply((d) => ({ ...d, signatures: [...d.signatures, sig] }))
      setSelectedSig(sig.id)
      setPendingSig(null)
      setFocusId(null)
      try {
        localStorage.setItem('form-desk-signature', sig.dataUrl)
      } catch {
        /* ignore private-mode storage failures */
      }
      return
    }
    if (pendingImage) {
      const current = docRef.current
      if (!current) return
      const width = 140
      const height = width / Math.max(pendingImage.aspect, 0.2)
      const image: ImageItem = {
        id: uid(),
        page: current.pageIndex,
        x: pt.x,
        y: pt.y,
        width,
        height,
        dataUrl: pendingImage.dataUrl,
      }
      gesture.current = false
      remember()
      apply((d) => ({ ...d, images: [...d.images, image] }))
      setPendingImage(null)
      return
    }
    createText(pt.x, pt.y)
  }

  function onCoverDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (tool !== 'whiteout' && tool !== 'highlight' && tool !== 'line') return
    if ((event.target as HTMLElement).closest('[data-overlay]')) return
    const pt = eventPoint(event)
    coverOrigin.current = pt
    setDraftCover({ x: pt.x, y: pt.y, w: 0, h: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onCoverMove(event: ReactPointerEvent<HTMLDivElement>) {
    const origin = coverOrigin.current
    if (!origin || (tool !== 'whiteout' && tool !== 'highlight' && tool !== 'line')) return
    const pt = eventPoint(event)
    setDraftCover({
      x: Math.min(origin.x, pt.x),
      y: Math.min(origin.y, pt.y),
      w: Math.abs(pt.x - origin.x),
      h: Math.abs(pt.y - origin.y),
    })
  }

  function onCoverUp(event: ReactPointerEvent<HTMLDivElement>) {
    const origin = coverOrigin.current
    coverOrigin.current = null
    if (!origin) return
    const pt = eventPoint(event)
    const rect = {
      x: Math.min(origin.x, pt.x),
      y: Math.min(origin.y, pt.y),
      w: Math.abs(pt.x - origin.x),
      h: Math.abs(pt.y - origin.y),
    }
    const current = docRef.current
    if (current && rect.w > 4 && rect.h > 4) {
      gesture.current = false
      remember()
      if (tool === 'highlight' || tool === 'line') {
        const mark: MarkItem = {
          id: uid(),
          page: current.pageIndex,
          kind: tool,
          x: rect.x,
          y: rect.y,
          width: rect.w,
          height: rect.h,
          color: tool === 'highlight' ? '#f2c14e' : '#1a1714',
        }
        apply((d) => ({ ...d, marks: [...d.marks, mark] }))
      } else {
        const cover: CoverItem = {
          id: uid(),
          page: current.pageIndex,
          x: rect.x,
          y: rect.y,
          width: rect.w,
          height: rect.h,
        }
        apply((d) => ({ ...d, covers: [...d.covers, cover] }))
        setSelectedCover(cover.id)
      }
    }
    setDraftCover(null)
  }

  function nudgeSelection(dx: number, dy: number) {
    const current = docRef.current
    if (!current) return
    gesture.current = false
    remember()
    if (editFocus) {
      apply((d) => ({
        ...d,
        edits: d.edits.map((edit) => (edit.id === editFocus ? { ...edit, x: edit.x + dx, baseline: edit.baseline + dy } : edit)),
      }))
    } else if (focusId) {
      apply((d) => ({
        ...d,
        texts: d.texts.map((item) => (item.id === focusId ? { ...item, x: item.x + dx, y: item.y + dy } : item)),
      }))
    }
  }

  function duplicateSelection() {
    const current = docRef.current
    if (!current) return
    gesture.current = false
    remember()
    if (editFocus) {
      const edit = current.edits.find((item) => item.id === editFocus)
      if (!edit) return
      const copy: TextItem = {
        id: uid(),
        page: edit.page,
        x: edit.x + 12,
        y: edit.baseline + 12,
        text: edit.text,
        fontSize: edit.fontSize,
        color: edit.color,
        align: edit.align,
        boxWidth: edit.boxWidth,
        boxHeight: edit.boxHeight,
        bold: edit.bold,
        font: edit.font,
        underline: edit.underline,
        background: edit.background,
      }
      apply((d) => ({ ...d, texts: [...d.texts, copy] }))
      setFocusId(copy.id)
      setEditFocus(null)
      return
    }
    if (!focusId) return
    const item = current.texts.find((entry) => entry.id === focusId)
    if (!item) return
    const copy: TextItem = { ...item, id: uid(), x: item.x + 12, y: item.y + 12 }
    apply((d) => ({ ...d, texts: [...d.texts, copy] }))
    setFocusId(copy.id)
  }

  function placeMark(kind: MarkKind, x: number, y: number) {
    const current = docRef.current
    if (!current) return
    const mark: MarkItem = {
      id: uid(),
      page: current.pageIndex,
      kind,
      x,
      y,
      width: kind === 'date' ? 96 : 22,
      height: kind === 'date' ? 16 : 22,
      color: '#1a1714',
      text: kind === 'date' ? new Date().toLocaleDateString() : undefined,
    }
    gesture.current = false
    remember()
    apply((d) => ({ ...d, marks: [...d.marks, mark] }))
    setTool('text')
  }

  function replaceAll() {
    const current = docRef.current
    if (!current || !findQuery) return
    gesture.current = false
    remember()
    apply((d) => {
      let edits = [...d.edits]
      for (const run of d.runs) {
        if (!run.text.includes(findQuery)) continue
        const text = run.text.split(findQuery).join(replaceWith)
        const existing = edits.find((edit) => edit.runId === run.id)
        const base: TextEdit = existing ?? {
          id: uid(),
          runId: run.id,
          page: run.page,
          x: run.x,
          baseline: run.baseline,
          text: run.text,
          fontSize: run.fontSize,
          color: run.color,
          bold: false,
          deleted: false,
          boxWidth: run.width,
          boxHeight: (run.ascent + run.descent) * run.fontSize,
          align: 'auto',
        }
        const next = { ...base, text, deleted: text.length === 0 }
        edits = existing ? edits.map((edit) => (edit.runId === run.id ? next : edit)) : [...edits, next]
      }
      return { ...d, edits }
    })
    setStatus(null)
  }

  async function commitPages(nextBytes: Uint8Array, map: (page: number) => number | null, nextIndex?: number) {
    const current = docRef.current
    if (!current) return
    const keptTexts = [
      ...current.texts,
      ...current.edits
        .filter((edit) => !edit.deleted && edit.text)
        .map((edit) => ({
          id: uid(),
          page: edit.page,
          x: edit.x,
          y: edit.baseline,
          text: edit.text,
          fontSize: edit.fontSize,
          color: edit.color,
          align: edit.align,
          boxWidth: edit.boxWidth,
          boxHeight: edit.boxHeight,
          bold: edit.bold,
          font: edit.font,
          underline: edit.underline,
          background: edit.background,
        })),
    ]
    remember()
    const loaded = await openPdf(nextBytes)
    const { pages, fields } = await readPagesAndFields(loaded)
    const runs = await extractRuns(loaded)
    if (pdfRef.current) await pdfRef.current.cleanup()
    pdfRef.current = loaded
    setPdf(loaded)
    publish({
      ...current,
      pdfBytes: nextBytes,
      pages,
      fields,
      runs,
      texts: remapPage(keptTexts, map),
      signatures: remapPage(current.signatures, map),
      covers: remapPage(current.covers, map),
      marks: remapPage(current.marks, map),
      images: remapPage(current.images, map),
      edits: [],
      pageIndex: clamp(nextIndex ?? current.pageIndex, 0, Math.max(0, pages.length - 1)),
    })
  }

  async function rotateCurrent() {
    const current = docRef.current
    if (!current) return
    const index = current.pageIndex
    const info = current.pages[index]
    if (!info) return
    const metricsNow = fontMetrics()
    const spin = <T extends { page: number }>(items: T[], turn: (item: T) => T) => items.map((item) => (item.page === index ? turn(item) : item))
    const texts = spin(current.texts, (item) => {
      const height = item.boxHeight ?? item.fontSize * (metricsNow.ascent + metricsNow.descent)
      const top = item.y - item.fontSize * metricsNow.ascent
      const box = rotateBox90({ x: item.x, y: top, width: item.boxWidth, height }, info.width, info.height)
      return { ...item, x: box.x, y: box.y + item.fontSize * metricsNow.ascent, boxWidth: box.width, boxHeight: box.height }
    })
    const boxOf = (item: { x: number; y: number; width: number; height: number }) => rotateBox90(item, info.width, info.height)
    const nextBytes = await rotatePdfPage(current.pdfBytes, index)
    remember()
    const loaded = await openPdf(nextBytes)
    const { pages, fields } = await readPagesAndFields(loaded)
    const runs = await extractRuns(loaded)
    if (pdfRef.current) await pdfRef.current.cleanup()
    pdfRef.current = loaded
    setPdf(loaded)
    publish({
      ...current,
      pdfBytes: nextBytes,
      pages,
      fields,
      runs,
      texts,
      signatures: spin(current.signatures, (item) => ({ ...item, ...boxOf(item) })),
      covers: spin(current.covers, (item) => ({ ...item, ...boxOf(item) })),
      marks: spin(current.marks, (item) => ({ ...item, ...boxOf(item) })),
      images: spin(current.images, (item) => ({ ...item, ...boxOf(item) })),
      edits: [],
    })
  }

  async function printDoc() {
    const current = docRef.current
    const fontBytes = getFontBytes()
    if (!current || !fontBytes) return
    const result = await exportPdf({
      pdfBytes: current.pdfBytes,
      fontBytes,
      texts: current.texts,
      signatures: current.signatures,
      covers: current.covers,
      runs: current.runs,
      edits: current.edits,
      marks: current.marks,
      images: current.images,
      values: current.values,
    })
    const blob = new Blob([new Uint8Array(result.bytes)], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const frame = document.createElement('iframe')
    frame.style.position = 'fixed'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    frame.src = url
    document.body.appendChild(frame)
    frame.onload = () => frame.contentWindow?.print()
  }

  function placeFieldValue(name: string, value: string | boolean) {
    if (!gesture.current) {
      remember()
      gesture.current = true
    }
    apply((d) => ({ ...d, values: { ...d.values, [name]: value } }))
  }

  useEffect(() => {
    if (!focusId) return
    const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')
    const field = document.querySelector<HTMLTextAreaElement>(`[data-text-id="${focusId}"]`)
    ;(composer ?? field)?.focus()
  }, [focusId])

  useEffect(() => {
    if (!editFocus) return
    document.querySelector<HTMLTextAreaElement>(`[data-edit-id="${editFocus}"]`)?.focus()
  }, [editFocus])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing = Boolean(target?.closest('input, textarea, select'))
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !typing) {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y' && !typing) {
        event.preventDefault()
        redo()
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void persist()
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && !typing) {
        event.preventDefault()
        duplicateSelection()
      } else if (!typing && (editFocus || focusId) && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
        const step = event.shiftKey ? 8 : 1
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
        nudgeSelection(dx, dy)
      } else if (event.key === 'Escape') {
        setPendingSig(null)
        setSignOpen(false)
        setFocusId(null)
        dropUnchangedEdits(null)
        setEditFocus(null)
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && !typing) {
        if (editFocus) {
          deleteEdit(editFocus)
        } else if (focusId) {
          removeText(focusId)
        } else if (selectedSig) {
          gesture.current = false
          remember()
          apply((d) => ({ ...d, signatures: d.signatures.filter((sig) => sig.id !== selectedSig) }))
          setSelectedSig(null)
        } else if (selectedCover) {
          gesture.current = false
          remember()
          apply((d) => ({ ...d, covers: d.covers.filter((cover) => cover.id !== selectedCover) }))
          setSelectedCover(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const page = doc?.pages[doc.pageIndex]
  const narrow = frameWidth < 760
  const scale = page ? displayScale(page.width, frameWidth, doc.zoom) : 1
  const activeText = doc?.texts.find((item) => item.id === focusId) ?? null
  const activeEdit = doc?.edits.find((item) => item.id === editFocus) ?? null
  const shownSize = activeEdit?.fontSize ?? activeText?.fontSize ?? doc?.fontSize ?? 11
  const shownColor = activeEdit?.color ?? activeText?.color ?? doc?.color ?? '#1a1714'
  const sizeChoices = [8, 9, 10, 11, 12, 13, 14, 16, 18, 22]
  const sizeOptions = sizeChoices.includes(shownSize) ? sizeChoices : [...sizeChoices, shownSize].sort((a, b) => a - b)
  const metrics = fontMetrics()

  return (
    <div
      className="app"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const file = event.dataTransfer.files[0]
        if (file) void onPick(file)
      }}
    >
      <header className="top">
        <div className="brand">
          <strong>Form desk</strong>
          <span className="muted">Private PDF editor. Files stay on this device.</span>
        </div>
        <div className="save-cluster">
          <span className="save" data-testid="save-state">
            {saveError ? 'Not saved' : saving ? 'Saving…' : savedAt ? `Saved at ${formatSaved(savedAt)}` : doc ? 'Not saved yet' : 'Autosaves in this browser'}
          </span>
          {doc ? (
            <button type="button" className="btn ghost" data-testid="start-fresh" onClick={() => setConfirmFresh(true)}>
              Start fresh
            </button>
          ) : null}
        </div>
      </header>

      {boot === 'loading' ? (
        <p className="boot" data-testid="boot">
          Checking this browser for a saved form…
        </p>
      ) : null}

      {boot === 'ready' && !doc ? (
        <section className="welcome" data-testid="welcome">
          <h1>Edit the form. Keep the file.</h1>
          <p>
            Open a PDF and choose Edit text to rewrite what’s already printed, in English or Hebrew. You can still add
            words, sign, and download. Nothing is uploaded.
          </p>
          <div className="welcome-actions">
            <button type="button" className="btn primary" onClick={() => fileRef.current?.click()}>
              Open a PDF
            </button>
            <button type="button" className="btn" data-testid="open-sample" onClick={() => void openSample()}>
              Try the sample time report
            </button>
          </div>
          <p className="drop-hint">Or drop a PDF anywhere on this page.</p>
          {recent.length ? (
            <div className="recent" data-testid="recent-docs">
              {recent.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="btn"
                  onClick={() => {
                    void loadNamedDoc(item.id).then((session) => {
                      if (session) void openBytes(bytesFromSession(session), session.fileName, session, true)
                    })
                  }}
                >
                  {item.fileName}
                </button>
              ))}
            </div>
          ) : null}
          <p className="heb-sample" dir="rtl">
            עברית ואנגלית
          </p>
        </section>
      ) : null}

      {doc && page ? (
        <>
          <div className="toolbar">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              Open
            </button>
            <button type="button" className="btn" onClick={() => void openSample()}>
              Sample
            </button>
            <label className="tool">
              Size
              <select
                value={shownSize}
                onChange={(event) => {
                  const fontSize = Number(event.target.value)
                  if (editFocus) remember()
                  apply((d) => ({
                    ...d,
                    fontSize,
                    texts: focusId ? d.texts.map((item) => (item.id === focusId ? { ...item, fontSize } : item)) : d.texts,
                    edits: editFocus ? d.edits.map((item) => (item.id === editFocus ? { ...item, fontSize } : item)) : d.edits,
                  }))
                }}
              >
                {sizeOptions.map((size) => (
                  <option key={size} value={size}>
                    {size} pt
                  </option>
                ))}
              </select>
            </label>
            <label className="tool">
              Color
              <input
                type="color"
                value={shownColor}
                aria-label="Text color"
                onChange={(event) => {
                  const color = event.target.value
                  if (editFocus) remember()
                  apply((d) => ({
                    ...d,
                    color,
                    texts: focusId ? d.texts.map((item) => (item.id === focusId ? { ...item, color } : item)) : d.texts,
                    edits: editFocus ? d.edits.map((item) => (item.id === editFocus ? { ...item, color } : item)) : d.edits,
                  }))
                }}
              />
            </label>
            <label className="tool">
              Align
              <select
                value={doc.align}
                aria-label="Text alignment"
                onChange={(event) => {
                  const align = event.target.value as Align
                  apply((d) => ({
                    ...d,
                    align,
                    texts: focusId ? d.texts.map((item) => (item.id === focusId ? { ...item, align } : item)) : d.texts,
                    edits: editFocus ? d.edits.map((item) => (item.id === editFocus ? { ...item, align } : item)) : d.edits,
                  }))
                }}
              >
                <option value="auto">Auto</option>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label className="tool">
              Cell
              <input
                className="num"
                type="number"
                min={20}
                max={400}
                aria-label="Cell width"
                value={doc.cellWidth}
                onChange={(event) => {
                  const cellWidth = clamp(Number(event.target.value) || 20, 20, 400)
                  apply((d) => ({
                    ...d,
                    cellWidth,
                    texts: focusId
                      ? d.texts.map((item) => (item.id === focusId ? { ...item, boxWidth: cellWidth } : item))
                      : d.texts,
                  }))
                }}
              />
            </label>
            <label className="tool">
              Row
              <input
                className="num"
                type="number"
                min={10}
                max={80}
                aria-label="Row height"
                value={doc.rowHeight}
                onChange={(event) => apply((d) => ({ ...d, rowHeight: clamp(Number(event.target.value) || 10, 10, 80) }))}
              />
            </label>
            <button
              type="button"
              className={tool === 'edit' ? 'btn on' : 'btn'}
              data-testid="edit-text"
              aria-pressed={tool === 'edit'}
              onClick={() => {
                setTool((current) => {
                  const next = current === 'edit' ? 'text' : 'edit'
                  if (next === 'edit' && !doc.runs.some((run) => run.page === doc.pageIndex)) {
                    setStatus('No selectable text on this page. Scanned or image-only PDFs cannot be edited this way. You can still add text on top.')
                  } else if (next === 'edit') {
                    setStatus(null)
                  }
                  return next
                })
              }}
            >
              Edit text
            </button>
            <button
              type="button"
              className={activeEdit?.bold || activeText?.bold ? 'btn on' : 'btn'}
              data-testid="bold"
              aria-pressed={Boolean(activeEdit?.bold || activeText?.bold)}
              onClick={() => {
                if (editFocus) {
                  remember()
                  apply((d) => ({ ...d, edits: d.edits.map((item) => (item.id === editFocus ? { ...item, bold: !item.bold } : item)) }))
                } else if (focusId) {
                  remember()
                  apply((d) => ({ ...d, texts: d.texts.map((item) => (item.id === focusId ? { ...item, bold: !item.bold } : item)) }))
                }
              }}
            >
              Bold
            </button>
            <button
              type="button"
              className={activeEdit?.underline || activeText?.underline ? 'btn on' : 'btn'}
              data-testid="underline"
              onClick={() => {
                if (editFocus) {
                  remember()
                  apply((d) => ({ ...d, edits: d.edits.map((item) => (item.id === editFocus ? { ...item, underline: !item.underline } : item)) }))
                } else if (focusId) {
                  remember()
                  apply((d) => ({ ...d, texts: d.texts.map((item) => (item.id === focusId ? { ...item, underline: !item.underline } : item)) }))
                }
              }}
            >
              Underline
            </button>
            <label className="tool">
              Font
              <select
                aria-label="Font"
                data-testid="font-choice"
                value={activeEdit?.font || activeText?.font || 'noto'}
                onChange={(event) => {
                  const font = event.target.value as FontId
                  remember()
                  apply((d) => ({
                    ...d,
                    texts: focusId ? d.texts.map((item) => (item.id === focusId ? { ...item, font } : item)) : d.texts,
                    edits: editFocus ? d.edits.map((item) => (item.id === editFocus ? { ...item, font } : item)) : d.edits,
                  }))
                }}
              >
                <option value="noto">Sans</option>
                <option value="script">Script</option>
              </select>
            </label>
            <label className="tool">
              Highlight
              <select
                aria-label="Box background"
                data-testid="box-background"
                value={activeEdit?.background || activeText?.background || ''}
                onChange={(event) => {
                  const background = event.target.value
                  remember()
                  apply((d) => ({
                    ...d,
                    texts: focusId ? d.texts.map((item) => (item.id === focusId ? { ...item, background } : item)) : d.texts,
                    edits: editFocus ? d.edits.map((item) => (item.id === editFocus ? { ...item, background } : item)) : d.edits,
                  }))
                }}
              >
                <option value="">None</option>
                <option value="#fff3b0">Yellow</option>
                <option value="#d7f5df">Green</option>
              </select>
            </label>
            <button
              type="button"
              className="btn"
              data-testid="delete-text"
              disabled={!activeEdit}
              onClick={() => {
                if (activeEdit) deleteEdit(activeEdit.id)
              }}
            >
              {activeEdit?.deleted ? 'Restore' : 'Delete text'}
            </button>
            <button type="button" className="btn" data-testid="merge-runs" disabled={picked.length < 2} onClick={mergePicked}>
              Merge
            </button>
            <button
              type="button"
              className="btn"
              data-testid="split-run"
              disabled={!doc.runs.some((run) => {
                const id = activeEdit ? activeEdit.runId : picked.length === 1 ? picked[0] : ''
                return run.id === id && (run.parts.length > 1 || run.text.trim().length > 1)
              })}
              onClick={splitFocused}
            >
              Split
            </button>
            <button
              type="button"
              className={tool === 'whiteout' ? 'btn on' : 'btn'}
              aria-pressed={tool === 'whiteout'}
              onClick={() => setTool((current) => (current === 'whiteout' ? 'text' : 'whiteout'))}
            >
              Whiteout
            </button>
            <button type="button" className="btn" data-testid="save-now" onClick={() => void persist()}>
              Save
            </button>
            <button type="button" className="btn" data-testid="print-doc" onClick={() => void printDoc()}>
              Print
            </button>
            <button type="button" className="btn" onClick={undo} disabled={hist.undo === 0}>
              Undo
            </button>
            <button type="button" className="btn" onClick={redo} disabled={hist.redo === 0}>
              Redo
            </button>
            <div className="zoom">
              <button type="button" className="btn" onClick={() => apply((d) => ({ ...d, zoom: clamp(d.zoom / 1.1, 0.35, 3) }))} aria-label="Zoom out">
                −
              </button>
              <button
                type="button"
                className="btn"
                data-testid="zoom-fit"
                onClick={() => {
                  if (!page) return
                  const available = Math.max(280, Math.min(frameWidth - 16, 920))
                  apply((d) => ({ ...d, zoom: available / page.width }))
                }}
              >
                {Math.round(doc.zoom * 100)}%
              </button>
              <button type="button" className="btn" onClick={() => apply((d) => ({ ...d, zoom: clamp(d.zoom * 1.1, 0.35, 3) }))} aria-label="Zoom in">
                +
              </button>
            </div>
            <button type="button" className="btn" data-testid="add-signature" onClick={() => setSignOpen(true)}>
              Sign
            </button>
            <button type="button" className="btn primary" data-testid="download" onClick={() => void download()} disabled={busy || !fontsReady}>
              {busy ? 'Preparing…' : 'Download'}
            </button>
          </div>
          <div className="toolbar more">
            <label className="tool">
              Stamp
              <select
                aria-label="Stamp"
                data-testid="stamp-tool"
                value={tool === 'highlight' || tool === 'line' || tool === 'check' || tool === 'cross' || tool === 'date' ? tool : ''}
                onChange={(event) => setTool((event.target.value || 'text') as Tool)}
              >
                <option value="">None</option>
                <option value="highlight">Highlight</option>
                <option value="line">Line</option>
                <option value="check">Check</option>
                <option value="cross">X</option>
                <option value="date">Date</option>
              </select>
            </label>
            <button type="button" className="btn" data-testid="add-image" onClick={() => imageRef.current?.click()}>
              Image
            </button>
            <button type="button" className="btn" data-testid="page-prev" onClick={() => apply((d) => ({ ...d, pageIndex: Math.max(0, d.pageIndex - 1) }))}>
              Prev
            </button>
            <button type="button" className="btn" data-testid="page-next" onClick={() => apply((d) => ({ ...d, pageIndex: Math.min(d.pages.length - 1, d.pageIndex + 1) }))}>
              Next
            </button>
            <button type="button" className="btn" data-testid="page-rotate" onClick={() => void rotateCurrent()}>
              Rotate
            </button>
            <button
              type="button"
              className="btn"
              data-testid="page-blank"
              onClick={() => {
                const info = doc.pages[doc.pageIndex]
                void insertBlankPage(doc.pdfBytes, doc.pageIndex + 1, info?.width ?? 612, info?.height ?? 792).then((bytes) =>
                  commitPages(bytes, pageMapInsert(doc.pageIndex + 1), doc.pageIndex + 1),
                )
              }}
            >
              Blank page
            </button>
            <button
              type="button"
              className="btn"
              data-testid="page-delete"
              disabled={doc.pages.length < 2}
              onClick={() => void deletePdfPage(doc.pdfBytes, doc.pageIndex).then((bytes) => commitPages(bytes, pageMapDelete(doc.pageIndex), Math.max(0, doc.pageIndex - 1)))}
            >
              Delete page
            </button>
            <button
              type="button"
              className="btn"
              data-testid="page-up"
              disabled={doc.pageIndex === 0}
              onClick={() => void movePdfPage(doc.pdfBytes, doc.pageIndex, doc.pageIndex - 1).then((bytes) => commitPages(bytes, pageMapMove(doc.pageIndex, doc.pageIndex - 1), doc.pageIndex - 1))}
            >
              Page up
            </button>
            <button
              type="button"
              className="btn"
              data-testid="page-down"
              disabled={doc.pageIndex >= doc.pages.length - 1}
              onClick={() => void movePdfPage(doc.pdfBytes, doc.pageIndex, doc.pageIndex + 1).then((bytes) => commitPages(bytes, pageMapMove(doc.pageIndex, doc.pageIndex + 1), doc.pageIndex + 1))}
            >
              Page down
            </button>
            <button type="button" className="btn" data-testid="page-merge" onClick={() => mergeRef.current?.click()}>
              Merge PDF
            </button>
            <label className="tool">
              Find
              <input data-testid="find-text" value={findQuery} onChange={(event) => setFindQuery(event.target.value)} />
            </label>
            <label className="tool">
              Replace
              <input data-testid="replace-text" value={replaceWith} onChange={(event) => setReplaceWith(event.target.value)} />
            </label>
            <button type="button" className="btn" data-testid="replace-all" onClick={replaceAll}>
              Replace all
            </button>
          </div>
          <p className="hint">
            {pendingSig
              ? 'Click the page where the signature should go. Esc cancels.'
              : tool === 'edit'
                ? 'Click a time or line to rewrite all of it. Shift-click boxes, then Merge or Split. Drag the teal bar to move; handles resize.'
                : 'Click where the words should start. Tab moves across, Enter moves down. Whiteout covers a printed line.'}
            {doc.fields.length ? ` ${doc.fields.length} fillable field${doc.fields.length === 1 ? '' : 's'} on this file.` : ''}
          </p>
          {restored ? (
            <p className="restored" data-testid="restored-note">
              Restored your last form from this browser.
              <button type="button" className="link" onClick={() => setRestored(false)}>
                Dismiss
              </button>
            </p>
          ) : null}
          {status ? <p className="status" data-testid="status">{status}</p> : null}
          {saveError ? <p className="status">{saveError}</p> : null}

          <div className="workspace">
            <aside className="thumbs" aria-label="Pages">
              {doc.pages.map((info, index) => (
                <button
                  key={info.width + '-' + index}
                  type="button"
                  className={index === doc.pageIndex ? 'thumb on' : 'thumb'}
                  onClick={() => apply((d) => ({ ...d, pageIndex: index }))}
                >
                  {thumbs[index] ? <img src={thumbs[index]} alt="" /> : <span className="thumb-fallback">{index + 1}</span>}
                  <span>{index + 1}</span>
                </button>
              ))}
            </aside>
            <div className="frame" ref={frameRef} data-testid="frame">
              <div
                className={tool === 'whiteout' || pendingSig ? 'sheet cross' : tool === 'edit' ? 'sheet editing' : 'sheet'}
                ref={sheetRef}
                data-testid="page-stage"
                style={{ width: page.width * scale, height: page.height * scale }}
                onClick={onSheetClick}
                onPointerDown={onCoverDown}
                onPointerMove={onCoverMove}
                onPointerUp={onCoverUp}
              >
                <PdfCanvas pdf={pdf} pageIndex={doc.pageIndex} scale={scale} />
                {doc.marks
                  .filter((mark) => mark.page === doc.pageIndex)
                  .map((mark) => (
                    <div
                      key={mark.id}
                      data-overlay
                      data-testid={`mark-${mark.kind}`}
                      className={mark.kind === 'highlight' ? 'mark highlight' : mark.kind === 'line' ? 'mark line' : 'mark'}
                      style={{ left: mark.x * scale, top: mark.y * scale, width: mark.width * scale, height: mark.height * scale }}
                    >
                      {mark.kind === 'check' ? '✓' : mark.kind === 'cross' ? '✕' : mark.kind === 'date' ? mark.text : ''}
                    </div>
                  ))}
                {doc.images
                  .filter((image) => image.page === doc.pageIndex)
                  .map((image) => (
                    <img
                      key={image.id}
                      data-overlay
                      alt=""
                      className="placed-image"
                      src={image.dataUrl}
                      style={{ left: image.x * scale, top: image.y * scale, width: image.width * scale, height: image.height * scale }}
                    />
                  ))}
                {doc.edits
                  .filter((edit) => edit.page === doc.pageIndex)
                  .map((edit) => {
                    const run = doc.runs.find((item) => item.id === edit.runId)
                    if (!run || (edit.id !== editFocus && !editDiffers(edit, run))) return null
                    const parts = run.parts.length ? run.parts : [{ x: run.x, baseline: run.baseline, width: run.width, text: run.text, fontSize: run.fontSize, ascent: run.ascent, descent: run.descent }]
                    return parts.map((part, index) => {
                      const box = partCover(part)
                      return (
                        <button
                          key={`${edit.id}-cover-${index}`}
                          type="button"
                          data-overlay
                          data-testid="edit-cover"
                          className={editFocus === edit.id ? 'edit-cover on' : 'edit-cover'}
                          style={{
                            left: box.x * scale,
                            top: box.y * scale,
                            width: box.width * scale,
                            height: box.height * scale,
                            background: run.background,
                          }}
                          onClick={(event) => {
                            event.stopPropagation()
                            setEditFocus(edit.id)
                            setFocusId(null)
                          }}
                        />
                      )
                    })
                  })}
                {guides.map((guide, index) => (
                  <div
                    key={`${guide.axis}-${guide.at}-${index}`}
                    className={guide.axis === 'x' ? 'guide guide-x' : 'guide guide-y'}
                    style={guide.axis === 'x' ? { left: guide.at * scale } : { top: guide.at * scale }}
                  />
                ))}
                {tool === 'edit'
                  ? doc.runs
                      .filter((run) => run.page === doc.pageIndex)
                      .filter((run) => {
                        const edit = doc.edits.find((item) => item.runId === run.id)
                        return !edit || (edit.id !== editFocus && !editDiffers(edit, run))
                      })
                      .map((run) => {
                        const box = runCoverBox(run)
                        return (
                          <button
                            key={run.id}
                            type="button"
                            data-overlay
                            data-testid="text-run"
                            data-text={run.text}
                            data-parts={run.parts.length}
                            className={picked.includes(run.id) ? 'run-hit picked' : 'run-hit'}
                            style={{
                              left: box.x * scale,
                              top: box.y * scale,
                              width: Math.max(box.width, 8) * scale,
                              height: Math.max(box.height, 8) * scale,
                            }}
                            onClick={(event) => {
                              event.stopPropagation()
                              if (event.shiftKey) {
                                setPicked((current) => (current.includes(run.id) ? current.filter((id) => id !== run.id) : [...current, run.id]))
                                return
                              }
                              setPicked([])
                              beginEdit(run)
                            }}
                          />
                        )
                      })
                  : null}
                {doc.edits
                  .filter((edit) => edit.page === doc.pageIndex && !edit.deleted)
                  .map((edit) => {
                    const run = doc.runs.find((item) => item.id === edit.runId)
                    if (!run || (edit.id !== editFocus && !editDiffers(edit, run))) return null
                    return (
                      <EditBox
                        key={edit.id}
                        edit={edit}
                        run={run}
                        scale={scale}
                        metrics={metrics}
                        onChange={(patch, live) => updateEdit(edit.id, patch, live)}
                        snapTargets={boxesExcept(edit.id)}
                        onGuides={setGuides}
                        onSelect={() => {
                          setEditFocus(edit.id)
                          setFocusId(null)
                          setSelectedSig(null)
                        }}
                      />
                    )
                  })}
                {doc.covers
                  .filter((cover) => cover.page === doc.pageIndex)
                  .map((cover) => (
                    <button
                      key={cover.id}
                      type="button"
                      data-overlay
                      className={selectedCover === cover.id ? 'cover on' : 'cover'}
                      style={{
                        left: cover.x * scale,
                        top: cover.y * scale,
                        width: cover.width * scale,
                        height: cover.height * scale,
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        setSelectedCover(cover.id)
                      }}
                    />
                  ))}
                {draftCover ? (
                  <div
                    className="cover draft"
                    style={{
                      left: draftCover.x * scale,
                      top: draftCover.y * scale,
                      width: draftCover.w * scale,
                      height: draftCover.h * scale,
                    }}
                  />
                ) : null}
                {doc.fields
                  .filter((field) => field.page === doc.pageIndex && !field.readOnly)
                  .map((field) => (
                    <FieldControl
                      key={field.id}
                      field={field}
                      scale={scale}
                      value={doc.values[field.name]}
                      onChange={(value) => placeFieldValue(field.name, value)}
                      onDone={() => {
                        gesture.current = false
                      }}
                    />
                  ))}
                {doc.texts
                  .filter((item) => item.page === doc.pageIndex)
                  .map((item) => (
                      <TextBox
                      key={item.id}
                      item={item}
                      scale={scale}
                      metrics={metrics}
                      narrow={narrow}
                      selected={focusId === item.id}
                      snapTargets={boxesExcept(item.id)}
                      onGuides={setGuides}
                      onGeometry={(patch, live) => updateTextBox(item.id, patch, live)}
                      onChange={(value) => updateText(item.id, value, true)}
                      onKeyDown={(event) => onTextKey(event, item)}
                      onFocus={() => {
                        setFocusId(item.id)
                        dropUnchangedEdits(null)
                        setEditFocus(null)
                        setSelectedSig(null)
                      }}
                      onBlur={() => {
                        gesture.current = false
                      }}
                      onRemove={() => removeText(item.id)}
                    />
                  ))}
                {doc.signatures
                  .filter((sig) => sig.page === doc.pageIndex)
                  .map((sig) => (
                    <SignatureBox
                      key={sig.id}
                      sig={sig}
                      scale={scale}
                      selected={selectedSig === sig.id}
                      onSelect={() => {
                        setSelectedSig(sig.id)
                        setFocusId(null)
                        dropUnchangedEdits(null)
                        setEditFocus(null)
                      }}
                      onChange={(patch, live) => {
                        if (live && !gesture.current) {
                          remember()
                          gesture.current = true
                        }
                        if (!live) gesture.current = false
                        apply((d) => ({
                          ...d,
                          signatures: d.signatures.map((item) => (item.id === sig.id ? { ...item, ...patch } : item)),
                        }))
                      }}
                    />
                  ))}
              </div>
            </div>
          </div>
          {narrow && activeText ? (
            <div className="composer">
              <textarea
                data-testid="composer"
                value={activeText.text}
                dir={hasHebrew(activeText.text) || activeText.align === 'right' ? 'rtl' : 'auto'}
                placeholder="Type in this cell"
                onChange={(event) => updateText(activeText.id, event.target.value, true)}
                onKeyDown={(event) => onTextKey(event, activeText)}
                onBlur={() => {
                  gesture.current = false
                }}
              />
            </div>
          ) : null}
        </>
      ) : null}

      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept="application/pdf,.pdf"
        data-testid="file-input"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          void onPick(file)
        }}
      />
      <input
        ref={imageRef}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg"
        data-testid="image-input"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          const reader = new FileReader()
          reader.onload = () => {
            const url = String(reader.result || '')
            const image = new Image()
            image.onload = () => setPendingImage({ dataUrl: url, aspect: image.width / Math.max(1, image.height) })
            image.src = url
          }
          reader.readAsDataURL(file)
        }}
      />
      <input
        ref={mergeRef}
        className="sr-only"
        type="file"
        accept="application/pdf,.pdf"
        data-testid="merge-input"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file || !doc) return
          void file.arrayBuffer().then((buffer) => appendPdf(doc.pdfBytes, new Uint8Array(buffer)).then((bytes) => commitPages(bytes, (page) => page, doc.pages.length)))
        }}
      />

      {signOpen ? (
        <SignatureDialog
          onCancel={() => setSignOpen(false)}
          onUse={(dataUrl, aspect) => {
            setSignOpen(false)
            setPendingSig({ dataUrl, aspect })
            setTool('text')
          }}
        />
      ) : null}

      {confirmFresh ? (
        <div className="modal-back" role="presentation">
          <div className="modal small" role="dialog" aria-labelledby="fresh-title">
            <h2 id="fresh-title">Start fresh?</h2>
            <p>This clears the form on screen and the copy saved in this browser.</p>
            <div className="row-actions">
              <button type="button" className="btn" onClick={() => setConfirmFresh(false)}>
                Keep working
              </button>
              <button type="button" className="btn primary" data-testid="confirm-fresh" onClick={() => void startFresh()}>
                Start fresh
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingFile ? (
        <div className="modal-back" role="presentation">
          <div className="modal small" role="dialog" aria-labelledby="replace-title">
            <h2 id="replace-title">Replace the open form?</h2>
            <p>The form you are filling will be replaced. The previous autosave is overwritten once you edit the new file.</p>
            <div className="row-actions">
              <button type="button" className="btn" onClick={() => setPendingFile(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  const next = pendingFile
                  setPendingFile(null)
                  void openBytes(next.bytes, next.name, null, false)
                }}
              >
                Open it
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function EditBox({
  edit,
  run,
  scale,
  metrics,
  snapTargets,
  onGuides,
  onChange,
  onSelect,
}: {
  edit: TextEdit
  run: TextRun
  scale: number
  metrics: { ascent: number; descent: number }
  snapTargets: Rect[]
  onGuides: (guides: Guide[]) => void
  onChange: (patch: Partial<TextEdit>, live: boolean) => void
  onSelect: () => void
}) {
  const align = resolvedAlign(edit.align ?? 'auto', edit.text)
  const rtl = align === 'right' || (edit.align ?? 'auto') === 'auto' && (hasHebrew(edit.text) || run.dir === 'rtl')
  const line = edit.fontSize * (metrics.ascent + metrics.descent)
  const height = edit.boxHeight || (run.ascent + run.descent) * edit.fontSize
  const width = edit.boxWidth || run.width
  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault()
      const step = event.shiftKey ? 8 : 1
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      onChange({ x: edit.x + dx, baseline: edit.baseline + dy }, true)
    }
  }
  return (
    <BoxFrame
      selected
      testId="text-edit"
      scale={scale}
      left={edit.x}
      top={edit.baseline - edit.fontSize * metrics.ascent}
      width={width}
      height={height}
      snapTargets={snapTargets}
      onGuides={onGuides}
      onCommit={(rect, live) => {
        if (!rect) {
          onChange({}, false)
          return
        }
        onChange(
          {
            x: rect.x,
            baseline: rect.y + edit.fontSize * metrics.ascent,
            boxWidth: rect.w,
            boxHeight: rect.h,
          },
          live,
        )
      }}
    >
      <textarea
        data-edit-id={edit.id}
        className="edit-text box-text"
        style={{
          fontSize: edit.fontSize * scale,
          lineHeight: `${line * scale}px`,
          fontWeight: edit.bold ? 700 : 400,
          color: edit.color,
          textAlign: align,
          textDecoration: edit.underline ? 'underline' : 'none',
          fontFamily: edit.font === 'script' && !hasHebrew(edit.text) ? '"Great Vibes", cursive' : '"Noto Sans Hebrew", sans-serif',
          background: edit.background || 'transparent',
        }}
        dir={rtl ? 'rtl' : 'ltr'}
        value={edit.text}
        spellCheck={false}
        onChange={(event) => onChange({ text: event.target.value, deleted: false }, true)}
        onKeyDown={onKeyDown}
        onFocus={onSelect}
        onBlur={() => onChange({}, false)}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      />
    </BoxFrame>
  )
}

function PdfCanvas({ pdf, pageIndex, scale }: { pdf: PDFDocumentProxy | null; pageIndex: number; scale: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !pdf) return
    let cancel = false
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    ;(async () => {
      try {
        const page = await pdf.getPage(pageIndex + 1)
        if (cancel) return
        const viewport = page.getViewport({ scale })
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const renderTask = page.render({ canvas, viewport })
        task = renderTask
        await renderTask.promise
      } catch (err) {
        if (!isCancelled(err) && !cancel) console.warn(err)
      }
    })()
    return () => {
      cancel = true
      task?.cancel()
    }
  }, [pdf, pageIndex, scale])
  return <canvas ref={ref} className="pdf-page" />
}

function TextBox({
  item,
  scale,
  metrics,
  narrow,
  selected,
  snapTargets,
  onGuides,
  onGeometry,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  onRemove,
}: {
  item: TextItem
  scale: number
  metrics: { ascent: number; descent: number }
  narrow: boolean
  selected: boolean
  snapTargets: Rect[]
  onGuides: (guides: Guide[]) => void
  onGeometry: (patch: Partial<TextItem>, live: boolean) => void
  onChange: (value: string) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
  onFocus: () => void
  onBlur: () => void
  onRemove: () => void
}) {
  const align = resolvedAlign(item.align, item.text)
  const line = item.fontSize * (metrics.ascent + metrics.descent)
  const height = item.boxHeight && item.boxHeight > 0
    ? item.boxHeight
    : Math.max(line, layoutLines(item.text || ' ', item.boxWidth, 0, (value) => measureTextWidth(value, item.fontSize)).length * line)
  const rtl = align === 'right' || (item.align === 'auto' && hasHebrew(item.text))
  return (
    <BoxFrame
      selected={selected}
      testId="text-box"
      scale={scale}
      left={item.x}
      top={item.y - item.fontSize * metrics.ascent}
      width={item.boxWidth}
      height={height}
      snapTargets={snapTargets}
      onGuides={onGuides}
      onCommit={(rect, live) => {
        if (!rect) {
          onGeometry({}, false)
          return
        }
        onGeometry(
          {
            x: rect.x,
            y: rect.y + item.fontSize * metrics.ascent,
            boxWidth: rect.w,
            boxHeight: rect.h,
          },
          live,
        )
      }}
    >
      <textarea
        data-text-id={item.id}
        className="pdf-text box-text"
        style={{
          fontSize: item.fontSize * scale,
          lineHeight: `${line * scale}px`,
          fontWeight: item.bold ? 700 : 400,
          color: item.color,
          textAlign: align,
          background: item.background || 'transparent',
          textDecoration: item.underline ? 'underline' : 'none',
          fontFamily: item.font === 'script' && !hasHebrew(item.text) ? '"Great Vibes", cursive' : '"Noto Sans Hebrew", sans-serif',
        }}
        dir={rtl ? 'rtl' : 'ltr'}
        value={item.text}
        spellCheck={false}
        readOnly={narrow}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      />
      {selected ? (
        <button type="button" className="mini-x" aria-label="Remove text" onMouseDown={(event) => event.preventDefault()} onClick={onRemove}>
          ×
        </button>
      ) : null}
    </BoxFrame>
  )
}

function FieldControl({
  field,
  scale,
  value,
  onChange,
  onDone,
}: {
  field: FormField
  scale: number
  value: string | boolean | undefined
  onChange: (value: string | boolean) => void
  onDone: () => void
}) {
  const style = {
    left: field.x * scale,
    top: field.y * scale,
    width: field.width * scale,
    height: field.height * scale,
    fontSize: Math.min(field.fontSize, field.height * 0.8) * scale,
  }
  if (field.kind === 'checkbox') {
    const checked = Boolean(value)
    return (
      <button
        type="button"
        data-overlay
        data-field={field.name}
        data-testid={`field-${field.name}`}
        className="check"
        style={style}
        role="checkbox"
        aria-checked={checked}
        aria-label={field.name}
        onClick={(event) => {
          event.stopPropagation()
          onChange(!checked)
          onDone()
        }}
      >
        {checked ? '✓' : ''}
      </button>
    )
  }
  if (field.kind === 'choice' && field.options?.length) {
    return (
      <select
        data-overlay
        data-field={field.name}
        className="pdf-field"
        style={style}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onDone}
        onClick={(event) => event.stopPropagation()}
      >
        <option value="">—</option>
        {field.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    )
  }
  if (field.kind === 'radio') {
    const selected = value === field.radioValue
    return (
      <button
        type="button"
        data-overlay
        data-field={field.name}
        className={selected ? 'radio on' : 'radio'}
        style={style}
        aria-label={field.radioValue || field.name}
        onClick={(event) => {
          event.stopPropagation()
          onChange(field.radioValue || 'Yes')
          onDone()
        }}
      />
    )
  }
  const text = typeof value === 'string' ? value : ''
  return (
    <textarea
      data-overlay
      data-field={field.name}
      data-testid={`field-${field.name}`}
      className="pdf-field"
      style={style}
      value={text}
      dir={hasHebrew(text) ? 'rtl' : 'ltr'}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onDone}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    />
  )
}

function SignatureBox({
  sig,
  scale,
  selected,
  onSelect,
  onChange,
}: {
  sig: SignatureItem
  scale: number
  selected: boolean
  onSelect: () => void
  onChange: (patch: Partial<SignatureItem>, live: boolean) => void
}) {
  const drag = useRef<{
    x: number
    y: number
    origX: number
    origY: number
    origW: number
    origH: number
    mode: 'move' | 'resize'
  } | null>(null)
  function down(event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    event.stopPropagation()
    event.preventDefault()
    onSelect()
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      origX: sig.x,
      origY: sig.y,
      origW: sig.width,
      origH: sig.height,
      mode,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    const state = drag.current
    if (!state) return
    const dx = (event.clientX - state.x) / scale
    const dy = (event.clientY - state.y) / scale
    if (state.mode === 'move') onChange({ x: state.origX + dx, y: state.origY + dy }, true)
    else {
      const width = Math.max(24, state.origW + dx)
      const height = Math.max(12, width * (state.origH / state.origW))
      onChange({ width, height }, true)
    }
  }
  function up() {
    if (!drag.current) return
    drag.current = null
    onChange({}, false)
  }
  return (
    <div
      data-overlay
      data-testid="signature"
      className={selected ? 'signature on' : 'signature'}
      style={{ left: sig.x * scale, top: sig.y * scale, width: sig.width * scale, height: sig.height * scale }}
      onPointerDown={(event) => down(event, 'move')}
      onPointerMove={move}
      onPointerUp={up}
      onClick={(event) => event.stopPropagation()}
    >
      <img src={sig.dataUrl} alt="Signature" draggable={false} />
      {selected ? <span className="handle" onPointerDown={(event) => down(event, 'resize')} /> : null}
    </div>
  )
}

function findText(list: TextItem[], current: TextItem, dx: number, dy: number, cellWidth: number, rowHeight: number): TextItem | null {
  if (dx !== 0) {
    const row = list.filter((item) => item.page === current.page && item.id !== current.id && Math.abs(item.y - current.y) < rowHeight * 0.45)
    const candidates = row.filter((item) => (dx > 0 ? item.x > current.x + 1 : item.x < current.x - 1))
    candidates.sort((a, b) => (dx > 0 ? a.x - b.x : b.x - a.x))
    return candidates[0] ?? null
  }
  const col = list.filter((item) => item.page === current.page && item.id !== current.id && Math.abs(item.x - current.x) < Math.max(8, cellWidth * 0.45))
  const candidates = col.filter((item) => (dy > 0 ? item.y > current.y + 1 : item.y < current.y - 1))
  candidates.sort((a, b) => (dy > 0 ? a.y - b.y : b.y - a.y))
  return candidates[0] ?? null
}

function takeSnap(doc: DocState): Snap {
  return {
    texts: doc.texts.map((item) => ({ ...item })),
    signatures: doc.signatures.map((item) => ({ ...item })),
    covers: doc.covers.map((item) => ({ ...item })),
    edits: doc.edits.map((item) => ({ ...item })),
    marks: doc.marks.map((item) => ({ ...item })),
    images: doc.images.map((item) => ({ ...item })),
    runs: doc.runs.map((item) => ({ ...item, parts: item.parts.map((part) => ({ ...part })) })),
    values: { ...doc.values },
  }
}

function guessZoom(pageWidth: number, rowHeight: number): number {
  const narrow = window.innerWidth < 760
  const frame = Math.max(280, Math.min(window.innerWidth - (narrow ? 24 : 160), 940))
  const fit = frame / pageWidth
  if (narrow) return Math.round(fit * 100) / 100
  const readable = 34 / Math.max(12, rowHeight)
  return Math.round(Math.min(2.2, Math.max(fit, Math.min(readable, 1.5))) * 100) / 100
}

function displayScale(pageWidth: number, frameWidth: number, zoom: number): number {
  const available = Math.max(280, Math.min(frameWidth - 16, 920))
  const fit = available / pageWidth
  if (Math.abs(zoom - fit) < 0.02) return fit
  return zoom
}

function formatSaved(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function uid(): string {
  return crypto.randomUUID()
}

function isCancelled(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name: string }).name === 'RenderingCancelledException'
}
