import type { DocState, SessionV1 } from './types.ts'

const DB_NAME = 'form-desk'
const STORE = 'session'
const KEY = 'current'

let database: IDBDatabase | null = null
let opening: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (database) return Promise.resolve(database)
  if (opening) return opening
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      database = req.result
      database.onversionchange = () => database?.close()
      resolve(database)
    }
    req.onerror = () => reject(req.error ?? new Error('Could not open storage'))
  })
  return opening
}

export async function loadSession(): Promise<SessionV1 | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(KEY)
    req.onsuccess = () => {
      const value = req.result as SessionV1 | undefined
      if (!value || value.version !== 1 || !value.pdf) {
        resolve(null)
        return
      }
      resolve(value)
    }
    req.onerror = () => reject(req.error)
  })
}

export function sessionFromDoc(doc: DocState, savedAt = Date.now()): SessionV1 {
  const pdf = doc.pdfBytes.buffer.slice(
    doc.pdfBytes.byteOffset,
    doc.pdfBytes.byteOffset + doc.pdfBytes.byteLength,
  ) as ArrayBuffer
  return {
    version: 1,
    savedAt,
    fileName: doc.fileName,
    pdf,
    texts: doc.texts,
    signatures: doc.signatures,
    covers: doc.covers,
    values: doc.values,
    pageIndex: doc.pageIndex,
    zoom: doc.zoom,
    fontSize: doc.fontSize,
    color: doc.color,
    cellWidth: doc.cellWidth,
    rowHeight: doc.rowHeight,
    align: doc.align,
  }
}

function putSession(db: IDBDatabase, session: SessionV1): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(session, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('Save aborted'))
  })
}

export async function saveSession(doc: DocState, savedAt = Date.now()): Promise<number> {
  const db = await openDb()
  const session = sessionFromDoc(doc, savedAt)
  await putSession(db, session)
  return savedAt
}

/** Starts an IndexedDB write without awaiting, for pagehide and beforeunload. */
export function saveSessionNow(doc: DocState, savedAt = Date.now()): void {
  if (!database) return
  const session = sessionFromDoc(doc, savedAt)
  database.transaction(STORE, 'readwrite').objectStore(STORE).put(session, KEY)
}

export async function clearSession(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export function bytesFromSession(session: SessionV1): Uint8Array {
  return new Uint8Array(session.pdf)
}
