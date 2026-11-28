import { withTimeout, type Entry, type Store } from './store'

const DB_NAME = 'osm-transit-editor'
const STORE_NAME = 'cache'
// Oldest entries are removed beyond this many, to keep the database small.
const MAX_ENTRIES = 1200
// Opening the database is given up after this long. Some browsers never answer it in private windows.
const OPEN_TIMEOUT_MS = 1500

/**
 * Keeps downloaded map data in IndexedDB across visits. Every operation fails quietly
 * when IndexedDB is missing or blocked, so the map still works without it.
 */
export class IndexedDbStore implements Store {
  private readonly database: Promise<IDBDatabase | undefined>

  constructor() {
    this.database = withTimeout(openDatabase(), OPEN_TIMEOUT_MS, undefined)
  }

  async get(key: string): Promise<Entry | undefined> {
    const db = await this.database
    if (!db) return undefined
    return request<Entry | undefined>(db, 'readonly', (store) => store.get(key))
  }

  async set(key: string, entry: Entry): Promise<void> {
    const db = await this.database
    if (!db) return
    await request(db, 'readwrite', (store) => store.put(entry, key))
    const count = await request<number>(db, 'readonly', (store) => store.count())
    if (count > MAX_ENTRIES) await removeOldest(db, count - MAX_ENTRIES)
  }
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB_NAME, 1)
      open.onupgradeneeded = () => open.result.createObjectStore(STORE_NAME).createIndex('savedAt', 'savedAt')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => resolve(undefined)
      open.onblocked = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

function request<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
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

/** Removes the entries saved longest ago. */
function removeOldest(db: IDBDatabase, count: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count
    const index = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).index('savedAt')
    const cursorRequest = index.openCursor()
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor || remaining <= 0) return resolve()
      cursor.delete()
      remaining--
      cursor.continue()
    }
    cursorRequest.onerror = () => resolve()
  })
}
