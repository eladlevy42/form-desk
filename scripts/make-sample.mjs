import { writeFileSync } from 'node:fs'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const W = 595.28
const H = 841.89

const doc = await PDFDocument.create()
const page = doc.addPage([W, H])
const font = await doc.embedFont(StandardFonts.Helvetica)
const bold = await doc.embedFont(StandardFonts.HelveticaBold)
const ink = rgb(0.15, 0.13, 0.11)
const rule = rgb(0.25, 0.27, 0.28)
const hair = rgb(0.62, 0.58, 0.52)
const headerFill = rgb(0.93, 0.9, 0.84)

const text = (value, x, y, size, face = font) => {
  page.drawText(value, { x, y, size, font: face, color: ink })
}

text('Weekly time report', 36, H - 46, 18, bold)
text('Click a cell and type. Tab moves across. Enter moves down.', 36, H - 64, 9)

text('Name', 36, H - 98, 10, bold)
page.drawLine({
  start: { x: 74, y: H - 100 },
  end: { x: 290, y: H - 100 },
  thickness: 0.7,
  color: rule,
})

text('Week of', 310, H - 98, 10, bold)
page.drawLine({
  start: { x: 362, y: H - 100 },
  end: { x: 559, y: H - 100 },
  thickness: 0.7,
  color: rule,
})

text('Production', 36, H - 126, 10, bold)

const form = doc.getForm()
const production = form.createTextField('production')
production.addToPage(page, {
  x: 108,
  y: H - 132,
  width: 250,
  height: 16,
  borderWidth: 0.8,
  borderColor: rgb(0.15, 0.4, 0.36),
  backgroundColor: rgb(1, 0.99, 0.9),
})
production.setFontSize(11)

const overtime = form.createCheckBox('overtime')
overtime.addToPage(page, {
  x: 376,
  y: H - 132,
  width: 13,
  height: 13,
  borderWidth: 1,
  borderColor: ink,
  backgroundColor: rgb(1, 1, 1),
})
text('Overtime week', 396, H - 129, 10)

const cols = [
  { title: 'Day', x: 36, w: 52 },
  { title: 'Date', x: 88, w: 72 },
  { title: 'In', x: 160, w: 58 },
  { title: 'Out', x: 218, w: 58 },
  { title: 'Meal', x: 276, w: 70 },
  { title: 'Hours', x: 346, w: 52 },
  { title: 'Notes', x: 398, w: 161 },
]
const tableTop = H - 156
const rowH = 26
const rowLabels = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const tableHeight = rowLabels.length * rowH
const tableBottom = tableTop - tableHeight
const tableRight = cols[cols.length - 1].x + cols[cols.length - 1].w

page.drawRectangle({
  x: 36,
  y: tableBottom,
  width: tableRight - 36,
  height: tableHeight,
  borderColor: rule,
  borderWidth: 1,
})

for (let i = 1; i < rowLabels.length; i++) {
  const y = tableTop - i * rowH
  page.drawLine({
    start: { x: 36, y },
    end: { x: tableRight, y },
    thickness: 0.45,
    color: hair,
  })
}

for (let i = 0; i < cols.length - 1; i++) {
  const x = cols[i].x + cols[i].w
  page.drawLine({
    start: { x, y: tableBottom },
    end: { x, y: tableTop },
    thickness: 0.45,
    color: hair,
  })
}

page.drawRectangle({
  x: 36.6,
  y: tableTop - rowH + 0.5,
  width: tableRight - 36 - 1.2,
  height: rowH - 1,
  color: headerFill,
})

for (const col of cols) {
  text(col.title, col.x + 6, tableTop - 17, 9, bold)
}

for (let i = 1; i < rowLabels.length; i++) {
  text(rowLabels[i], 44, tableTop - i * rowH - 17, 10)
}

const sigBaseline = tableBottom - 64
text('Performer signature', 36, sigBaseline, 10, bold)
page.drawLine({
  start: { x: 158, y: sigBaseline - 2 },
  end: { x: 390, y: sigBaseline - 2 },
  thickness: 0.8,
  color: rule,
})
text('Date', 408, sigBaseline, 10, bold)
page.drawLine({
  start: { x: 440, y: sigBaseline - 2 },
  end: { x: 559, y: sigBaseline - 2 },
  thickness: 0.8,
  color: rule,
})

text('Practice sheet. Your file stays in this browser.', 36, 32, 8)

const pdfBytes = await doc.save()
writeFileSync(new URL('../public/sample-time-report.pdf', import.meta.url), pdfBytes)

const visualY = (pdfY) => Math.round((H - pdfY) * 100) / 100
const cellClick = (colIndex, rowIndex) => {
  const col = cols[colIndex]
  const pdfTop = tableTop - rowIndex * rowH
  const pdfMid = pdfTop - rowH / 2
  return {
    x: Math.round((col.x + 8) * 100) / 100,
    y: visualY(pdfMid),
    label: `${rowLabels[rowIndex] || 'header'} ${col.title}`,
  }
}

const layout = {
  page: { width: W, height: H },
  fontSize: 11,
  cellWidth: 58,
  rowHeight: 26,
  clicks: {
    name: { x: 86, y: visualY(H - 96), label: 'Name' },
    week: { x: 372, y: visualY(H - 96), label: 'Week of' },
    monDate: cellClick(1, 1),
    monIn: cellClick(2, 1),
    monOut: cellClick(3, 1),
    monNotes: cellClick(6, 1),
    tueIn: cellClick(2, 2),
    signature: { x: 175, y: visualY(sigBaseline + 8), label: 'Signature' },
    signDate: { x: 452, y: visualY(sigBaseline + 6), label: 'Sign date' },
  },
}

writeFileSync(
  new URL('../public/sample-time-report.layout.json', import.meta.url),
  JSON.stringify(layout, null, 2),
)
console.log(JSON.stringify(layout, null, 2))
