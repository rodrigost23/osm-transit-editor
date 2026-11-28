import { describe, expect, it, vi } from 'vitest'
import { searchPlace } from '@/core/data/nominatim'

describe('searchPlace', () => {
  it('returns the first match as numbers, with its name', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify([{ lat: '-22.9068', lon: '-43.1729', display_name: 'Rio de Janeiro, Brasil' }]), { status: 200 }),
    )
    const place = await searchPlace('Rio de Janeiro', 'https://nominatim.test', fetchFn)
    expect(place).toEqual({ lat: -22.9068, lon: -43.1729, name: 'Rio de Janeiro, Brasil' })
    expect(String((fetchFn.mock.calls[0] as unknown as [string])[0])).toBe('https://nominatim.test/search?format=json&limit=1&q=Rio%20de%20Janeiro')
  })

  it('returns null when nothing matches or the coordinates are not numbers', async () => {
    const none = async () => new Response('[]', { status: 200 })
    expect(await searchPlace('x', 'https://n.test', none)).toBeNull()
    const bad = async () => new Response('[{"lat":"x","lon":"1","display_name":"?"}]', { status: 200 })
    expect(await searchPlace('x', 'https://n.test', bad)).toBeNull()
  })

  it('throws with the HTTP status when the service refuses', async () => {
    const refused = async () => new Response('busy', { status: 429 })
    await expect(searchPlace('x', 'https://n.test', refused)).rejects.toThrow('HTTP 429')
  })
})
