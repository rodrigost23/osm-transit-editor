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

/** Reads the memory layer first, then the disk layer. Disk errors are ignored: the cache is optional. */
export class LayeredStore implements Store {
  private readonly memory: Store
  private readonly disk: Store

  constructor(memory: Store, disk: Store) {
    this.memory = memory
    this.disk = disk
  }

  async get(key: string): Promise<Entry | undefined> {
    const inMemory = await this.memory.get(key)
    if (inMemory) return inMemory
    const onDisk = await this.disk.get(key).catch(() => undefined)
    if (onDisk) await this.memory.set(key, onDisk)
    return onDisk
  }

  async set(key: string, entry: Entry): Promise<void> {
    await this.memory.set(key, entry)
    await this.disk.set(key, entry).catch(() => undefined)
  }
}
