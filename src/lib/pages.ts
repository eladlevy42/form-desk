import { PDFDocument, degrees } from 'pdf-lib'

export async function deletePdfPage(bytes: Uint8Array, index: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice())
  if (doc.getPageCount() <= 1) return bytes
  doc.removePage(index)
  return doc.save()
}

export async function movePdfPage(bytes: Uint8Array, from: number, to: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice())
  const count = doc.getPageCount()
  if (from < 0 || to < 0 || from >= count || to >= count || from === to) return bytes
  const [moved] = await doc.copyPages(doc, [from])
  doc.removePage(from)
  const insertAt = from < to ? to : to
  doc.insertPage(insertAt, moved)
  return doc.save()
}

export async function insertBlankPage(bytes: Uint8Array, index: number, width: number, height: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice())
  const page = doc.insertPage(index)
  page.setSize(width, height)
  return doc.save()
}

export async function rotatePdfPage(bytes: Uint8Array, index: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice())
  const page = doc.getPage(index)
  const angle = (page.getRotation().angle + 90) % 360
  page.setRotation(degrees(angle))
  return doc.save()
}

export async function appendPdf(bytes: Uint8Array, extra: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes.slice())
  const other = await PDFDocument.load(extra.slice())
  const copied = await doc.copyPages(other, other.getPageIndices())
  copied.forEach((page) => doc.addPage(page))
  return doc.save()
}

export function pageMapDelete(index: number): (page: number) => number | null {
  return (page) => {
    if (page === index) return null
    return page > index ? page - 1 : page
  }
}

export function pageMapInsert(index: number): (page: number) => number | null {
  return (page) => (page >= index ? page + 1 : page)
}

export function pageMapMove(from: number, to: number): (page: number) => number | null {
  return (page) => {
    if (page === from) return to
    if (from < to && page > from && page <= to) return page - 1
    if (from > to && page >= to && page < from) return page + 1
    return page
  }
}

type Box = { x: number; y: number; width: number; height: number }

/** Map a top-left box through a 90° clockwise view rotation. */
export function rotateBox90(box: Box, _pageWidth: number, pageHeight: number): Box {
  return {
    x: pageHeight - (box.y + box.height),
    y: box.x,
    width: box.height,
    height: box.width,
  }
}

export function remapPage<T extends { page: number }>(items: T[], map: (page: number) => number | null): T[] {
  const next: T[] = []
  for (const item of items) {
    const page = map(item.page)
    if (page == null) continue
    next.push({ ...item, page })
  }
  return next
}
