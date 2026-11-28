import { withTimeout, type Entry, type Store } from './store'

const DB_NAME = 'osm-transit-editor'
// Version 2 keeps the same object store. Version 1 entries are read once by the route loader, then removed.
const DB_VERSION = 2
const STORE_NAME = 'cache'
// Opening the database is given up after this long. Some browsers never answer it in private windows.
const OPEN_TIMEOUT_MS = 1500
// After a failed open, the database is tried again after this long, so a slow start does not disable the disk cache for the page.
const RETRY_AFTER_MS = 10_000

/**
 * Keeps downloaded map data in IndexedDB across visits. Every operation fails quietly
 * when IndexedDB is missing or blocked, so the map still works without it.
 */
export class IndexedDbStore implements Store {
  private database: Promise<IDBDatabase | undefined> | undefined
  private failedAt = Number.NEGATIVE_INFINITY

  private open(): Promise<IDBDatabase | undefined> | undefined {
    if (!this.database) {
      if (Date.now() - this.failedAt < RETRY_AFTER_MS) return undefined
      this.database = withTimeout(openDatabase(), OPEN_TIMEOUT_MS, undefined).then((db) => {
        if (!db) {
          this.failedAt = Date.now()
          this.database = undefined
        }
        return db
      })
    }
    return this.database
  }

  async get(key: string): Promise<Entry | undefined> {
    const db = await this.open()
    if (!db) return undefined
    return request<Entry | undefined>(db, 'readonly', (store) => store.get(key))
  }

  async set(key: string, entry: Entry): Promise<void> {
    const db = await this.open()
    if (!db) return
    await request(db, 'readwrite', (store) => store.put(entry, key))
  }

  async delete(key: string): Promise<void> {
    const db = await this.open()
    if (!db) return
    await request(db, 'readwrite', (store) => store.delete(key))
  }

  async scan(prefix: string): Promise<[string, Entry][]> {
    const db = await this.open()
    if (!db) return []
    return new Promise((resolve, reject) => {
      const found: [string, Entry][] = []
      const cursorRequest = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) return resolve(found)
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) found.push([cursor.key, cursor.value as Entry])
        cursor.continue()
      }
      cursorRequest.onerror = () => reject(cursorRequest.error)
    })
  }
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB_NAME, DB_VERSION)
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE_NAME)) open.result.createObjectStore(STORE_NAME)
      }
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => resolve(undefined)
      open.onblocked = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      const req = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
    } catch (error) {
      reject(error)
    }
  })
}
