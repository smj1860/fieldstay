import { describe, it, expect, vi, afterEach } from 'vitest'
import { sha256Hex, describeCapture } from '@/lib/evidence/capture'

afterEach(() => { vi.unstubAllGlobals() })

describe('sha256Hex', () => {
  it('hashes known bytes', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('describeCapture', () => {
  it('returns null GPS when the Permissions API is absent', async () => {
    vi.stubGlobal('navigator', {})
    const out = await describeCapture(new Blob(['abc']))
    expect(out.lat).toBeNull()
    expect(out.lng).toBeNull()
    expect(out.gps_accuracy_m).toBeNull()
    expect(out.byte_size).toBe(3)
    expect(out.sha256).toHaveLength(64)
  })

  it('returns null GPS when geolocation permission is not already granted', async () => {
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'prompt' }) },
      geolocation: { getCurrentPosition: vi.fn() },
    })
    const out = await describeCapture(new Blob(['x']))
    expect(out.lat).toBeNull()
  })

  it('reads the position when permission is already granted', async () => {
    vi.stubGlobal('navigator', {
      permissions: { query: async () => ({ state: 'granted' }) },
      geolocation: {
        getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void) =>
          ok({ coords: { latitude: 36.1234567, longitude: -86.7654321, accuracy: 12.34 } }),
      },
    })
    const out = await describeCapture(new Blob(['x']))
    expect(out.lat).toBe(36.123457)
    expect(out.lng).toBe(-86.765432)
    expect(out.gps_accuracy_m).toBe(12.3)
  })
})
