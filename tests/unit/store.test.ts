import { describe, expect, it } from 'vitest'
import { LayeredStore, MemoryStore, type Store } from '@/core/data/store'

const entry = (value: string) => ({ value, savedAt: 0 })

describe('MemoryStore', () => {
  it('forgets the least recently used entries past its limit', async () => {
    const store = new MemoryStore(2)
    await store.set('a', entry('a'))
    await store.set('b', entry('b'))
    await store.get('a')
    await store.set('c', entry('c'))
    expect(await store.get('a')).toBeDefined()
    expect(await store.get('b')).toBeUndefined()
    expect(await store.get('c')).toBeDefined()
  })
})

describe('LayeredStore', () => {
  it('reads from the disk layer when memory is empty, and keeps the copy in memory', async () => {
    const memory = new MemoryStore(10)
    const disk = new MemoryStore(10)
    await disk.set('a', entry('from disk'))
    const store = new LayeredStore(memory, disk)
    expect((await store.get('a'))?.value).toBe('from disk')
    expect((await memory.get('a'))?.value).toBe('from disk')
  })

  it('treats a disk layer that never answers as a miss', async () => {
    const never: Store = {
      get: () => new Promise<never>(() => {}),
      set: () => new Promise<never>(() => {}),
    }
    const store = new LayeredStore(new MemoryStore(10), never, 10)
    expect(await store.get('a')).toBeUndefined()
    await expect(store.set('a', entry('a'))).resolves.toBeUndefined()
  })

  it('keeps working when the disk layer fails', async () => {
    const broken: Store = {
      get: async () => {
        throw new Error('blocked')
      },
      set: async () => {
        throw new Error('blocked')
      },
    }
    const store = new LayeredStore(new MemoryStore(10), broken)
    await expect(store.set('a', entry('a'))).resolves.toBeUndefined()
    expect(await store.get('a')).toBeDefined()
    expect(await store.get('missing')).toBeUndefined()
  })
})
