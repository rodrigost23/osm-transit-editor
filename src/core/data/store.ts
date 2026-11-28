// Small cache layers for downloaded map data. Each entry records when it was saved,
// so the loader can tell fresh data from stale data.

export interface Entry {
  value: unknown
  savedAt: number
}

export interface Store {
  get(key: string): Promise<Entry | undefined>
  set(key: string, entry: Entry): Promise<void>
}

/** Keeps the most recently used entries in memory. */
export class MemoryStore implements Store {
  private readonly items = new Map<string, Entry>()
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  async get(key: string): Promise<Entry | undefined> {
    const entry = this.items.get(key)
    if (entry) {
      this.items.delete(key)
      this.items.set(key, entry)
    }
    return entry
  }

  async set(key: string, entry: Entry): Promise<void> {
    this.items.delete(key)
    this.items.set(key, entry)
    while (this.items.size > this.limit) {
      const oldest = this.items.keys().next().value
      if (oldest === undefined) break
      this.items.delete(oldest)
    }
  }
}

/** Resolves with the promise's value, or with the fallback if it fails or takes longer than ms. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

// Disk reads and writes are given up after this long, so a stuck database cannot stop the network.
const DISK_TIMEOUT_MS = 1500

/**
 * Reads the memory layer first, then the disk layer. The disk layer is optional: its
 * errors are ignored, and a read or write that takes too long is treated as a miss.
 */
export class LayeredStore implements Store {
  private readonly memory: Store
  private readonly disk: Store
  private readonly diskTimeoutMs: number

  constructor(memory: Store, disk: Store, diskTimeoutMs = DISK_TIMEOUT_MS) {
    this.memory = memory
    this.disk = disk
    this.diskTimeoutMs = diskTimeoutMs
  }

  async get(key: string): Promise<Entry | undefined> {
    const inMemory = await this.memory.get(key)
    if (inMemory) return inMemory
    const onDisk = await withTimeout(this.disk.get(key).catch(() => undefined), this.diskTimeoutMs, undefined)
    if (onDisk) await this.memory.set(key, onDisk)
    return onDisk
  }

  async set(key: string, entry: Entry): Promise<void> {
    await this.memory.set(key, entry)
    await withTimeout(this.disk.set(key, entry).catch(() => undefined), this.diskTimeoutMs, undefined)
  }
}
