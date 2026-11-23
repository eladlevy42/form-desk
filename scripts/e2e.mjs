import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const BASE = 'http://127.0.0.1:43123'
const OUT = '/opt/cursor/artifacts'
const DOWNLOADS = '/tmp/form-desk-dl'
mkdirSync(OUT, { recursive: true })
rmSync(DOWNLOADS, { recursive: true, force: true })
mkdirSync(DOWNLOADS, { recursive: true })

const layout = JSON.parse(readFileSync(new URL('../public/sample-time-report.layout.json', import.meta.url), 'utf8'))

const browser = await puppeteer.launch({
  executablePath: '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
const client = await page.createCDPSession()
await client.send('Page.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: DOWNLOADS,
})

const errors = []
page.on('pageerror', (err) => errors.push(String(err)))
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})

await page.goto(BASE, { waitUntil: 'networkidle0' })
await page.waitForSelector('[data-testid="welcome"]')
await page.screenshot({ path: `${OUT}/01-welcome.png` })

await page.click('[data-testid="open-sample"]')
await page.waitForSelector('[data-testid="page-stage"] canvas')
await page.waitForFunction(() => {
  const canvas = document.querySelector('[data-testid="page-stage"] canvas')
  return canvas && canvas.width > 100
})
await page.screenshot({ path: `${OUT}/02-sample-open.png` })

async function clickPdf(point) {
  const box = await page.$eval('[data-testid="page-stage"]', (el) => {
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  const x = box.x + (point.x / layout.page.width) * box.width
  const y = box.y + (point.y / layout.page.height) * box.height
  await page.mouse.click(x, y)
}

async function insertText(text) {
  await page.evaluate((value) => {
    document.execCommand('insertText', false, value)
  }, text)
}

await clickPdf(layout.clicks.name)
await page.waitForSelector('textarea.pdf-text')
await insertText('Elad Levy')

await clickPdf(layout.clicks.monDate)
await insertText('23 Nov')

await clickPdf(layout.clicks.monIn)
await insertText('09:00')
await page.keyboard.press('Enter')
await insertText('10:00')

const textsAfterEnter = await page.$$eval('textarea.pdf-text', (nodes) => nodes.map((node) => node.value))
if (!textsAfterEnter.includes('09:00') || !textsAfterEnter.includes('10:00')) {
  throw new Error(`Enter did not add the next row: ${JSON.stringify(textsAfterEnter)}`)
}

await clickPdf(layout.clicks.monIn)
await page.keyboard.press('Tab')
await insertText('18:00')

await clickPdf(layout.clicks.monNotes)
await insertText('שעות נוספות')

await clickPdf(layout.clicks.week)
await insertText('23 Nov 2026')

await page.click('[data-testid="field-production"]')
await insertText('אגם הפקות')
await page.click('[data-testid="field-overtime"]')

await page.click('[data-testid="add-signature"]')
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('.tab')].find((button) => button.textContent === 'Type')
  tab?.click()
})
await page.waitForSelector('[data-testid="signature-type"]')
await page.click('[data-testid="signature-type"]')
await insertText('Elad Levy')
await page.click('[data-testid="signature-use"]')
await clickPdf(layout.clicks.signature)
await page.waitForSelector('[data-testid="signature"]')

await page.waitForFunction(() => {
  const el = document.querySelector('[data-testid="save-state"]')
  return el && el.textContent.includes('Saved at')
})
await page.screenshot({ path: `${OUT}/03-filled-desktop.png` })

const before = await page.evaluate(() => ({
  texts: [...document.querySelectorAll('textarea.pdf-text')].map((node) => node.value),
  production: document.querySelector('[data-testid="field-production"]')?.value,
  overtime: document.querySelector('[data-testid="field-overtime"]')?.getAttribute('aria-checked'),
  saved: document.querySelector('[data-testid="save-state"]')?.textContent,
}))
console.log('before reload', before)

await page.reload({ waitUntil: 'networkidle0' })
await page.waitForFunction(() => {
  const areas = [...document.querySelectorAll('textarea.pdf-text')]
  return areas.some((node) => node.value === 'Elad Levy') && areas.some((node) => node.value === 'שעות נוספות')
})
await page.waitForFunction(() => document.querySelector('[data-testid="field-production"]')?.value === 'אגם הפקות')
await page.waitForSelector('[data-testid="signature"]')
await page.waitForSelector('[data-testid="restored-note"]')
const after = await page.evaluate(() => ({
  texts: [...document.querySelectorAll('textarea.pdf-text')].map((node) => node.value),
  production: document.querySelector('[data-testid="field-production"]')?.value,
  overtime: document.querySelector('[data-testid="field-overtime"]')?.getAttribute('aria-checked'),
}))
console.log('after reload', after)
if (after.overtime !== 'true') throw new Error('Overtime checkbox was not restored')
await page.screenshot({ path: `${OUT}/04-restored.png` })

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
await page.waitForSelector('[data-testid="page-stage"]')
await page.click('[data-testid="zoom-fit"]')
await new Promise((resolve) => setTimeout(resolve, 300))
await page.screenshot({ path: `${OUT}/05-mobile.png`, fullPage: true })
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
await page.click('[data-testid="zoom-fit"]')

await page.click('[data-testid="download"]')
let downloaded = ''
for (let i = 0; i < 40; i += 1) {
  const files = readdirSync(DOWNLOADS).filter((name) => name.endsWith('.pdf'))
  if (files.length) {
    downloaded = `${DOWNLOADS}/${files[0]}`
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!downloaded) throw new Error(`No download. Console: ${errors.join('\n')}`)
console.log('downloaded', downloaded, readFileSync(downloaded).length)

const fileBytes = readFileSync(downloaded)
if (!fileBytes.includes(Buffer.from('/Subtype /Image'))) {
  throw new Error('Downloaded PDF has no embedded image for the signature')
}
const pdf = await getDocument({
  data: new Uint8Array(fileBytes),
  disableWorker: true,
  isEvalSupported: false,
}).promise
const pdfPage = await pdf.getPage(1)
const content = await pdfPage.getTextContent()
const strings = content.items.map((item) => item.str)
const joined = strings.join(' | ')
console.log('pdf text sample', joined.slice(0, 1500))

function itemNear(needle) {
  return content.items.find((item) => typeof item.str === 'string' && item.str.includes(needle))
}

const nameItem = itemNear('Elad Levy')
const inItem = itemNear('09:00')
const outItem = itemNear('18:00')
const tueItem = itemNear('10:00')
if (!nameItem || !inItem || !outItem || !tueItem) {
  throw new Error(`Missing expected strings in PDF: ${joined}`)
}
const hebrewOk = strings.some((value) => value.includes('שעות') || value.includes('תועש') || value.includes('נוספות'))
const companyOk = strings.some((value) => value.includes('אגם') || value.includes('הפקות') || [...value].some((ch) => /[\u0590-\u05FF]/.test(ch)))
if (!hebrewOk) throw new Error(`Hebrew note missing from PDF: ${joined}`)
if (!companyOk) throw new Error(`Hebrew production field missing from PDF: ${joined}`)

const nameX = nameItem.transform[4]
const nameY = nameItem.transform[5]
console.log('positions', {
  name: [nameX, nameY],
  in: [inItem.transform[4], inItem.transform[5]],
  out: [outItem.transform[4], outItem.transform[5]],
  tue: [tueItem.transform[4], tueItem.transform[5]],
})
if (Math.abs(nameX - 86) > 20) throw new Error(`Name x ${nameX} is far from the name line`)
if (Math.abs(nameY - (layout.page.height - (layout.clicks.name.y + 11 * 0.3))) > 18) {
  throw new Error(`Name baseline y ${nameY} is far from the name line`)
}

await page.click('[data-testid="start-fresh"]')
await page.click('[data-testid="confirm-fresh"]')
await page.waitForSelector('[data-testid="welcome"]')
const input = await page.$('[data-testid="file-input"]')
await input.uploadFile(downloaded)
await page.waitForSelector('[data-testid="page-stage"] canvas')
await page.waitForFunction(() => {
  const canvas = document.querySelector('[data-testid="page-stage"] canvas')
  return canvas && canvas.width > 100
})
await new Promise((resolve) => setTimeout(resolve, 400))
await page.screenshot({ path: `${OUT}/06-reopened-download.png` })

await page.click('[data-testid="start-fresh"]')
await page.click('[data-testid="confirm-fresh"]')
await page.waitForSelector('[data-testid="welcome"]')
await page.reload({ waitUntil: 'networkidle0' })
await page.waitForSelector('[data-testid="welcome"]')
const restoredAfterClear = await page.$('[data-testid="restored-note"]')
if (restoredAfterClear) throw new Error('Start fresh did not clear the saved form')

if (errors.length) console.log('page errors', errors)
await browser.close()
console.log('E2E OK')
