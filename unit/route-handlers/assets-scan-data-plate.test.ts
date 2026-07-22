import { describe, it, expect, vi, beforeEach } from 'vitest'

// Next.js aliases this to an empty module at build time; vitest needs an
// explicit stub since the real package isn't installed as a dependency.
vi.mock('server-only', () => ({}))

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  scanLimiter: { limit: vi.fn(async () => ({ success: true })) },
}))
vi.mock('@/lib/assets/scan-data-plate', () => ({
  scanDataPlateImage:   vi.fn(),
  isValidScanMediaType: vi.fn(),
}))

import { POST } from '@/app/api/assets/scan-data-plate/route'
import { requireOrgMember } from '@/lib/auth'
import { scanLimiter } from '@/lib/rate-limit'
import { scanDataPlateImage, isValidScanMediaType } from '@/lib/assets/scan-data-plate'

const USER_ID = 'user_1'

function mockAuthed() {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user:       { id: USER_ID } as never,
    supabase:   {} as never,
    membership: { org_id: 'org_1', role: 'admin', org: {} as never },
  } as never)
}

function postRequest(body: unknown) {
  return new Request('http://localhost/api/assets/scan-data-plate', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('POST /api/assets/scan-data-plate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(scanLimiter.limit).mockResolvedValue({ success: true } as never)
    vi.mocked(isValidScanMediaType).mockReturnValue(true)
  })

  it('propagates the redirect when the caller is not an authenticated org member', async () => {
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    await expect(POST(postRequest({ imageBase64: 'abc', mediaType: 'image/jpeg' }))).rejects.toThrow('REDIRECT:/login')
    expect(scanLimiter.limit).not.toHaveBeenCalled()
  })

  it('returns 429 and never calls the vision model when the daily scan limit is exceeded', async () => {
    mockAuthed()
    vi.mocked(scanLimiter.limit).mockResolvedValue({ success: false } as never)

    const res = await POST(postRequest({ imageBase64: 'abc', mediaType: 'image/jpeg' }))

    expect(res.status).toBe(429)
    expect(scanDataPlateImage).not.toHaveBeenCalled()
  })

  it('rejects a request missing imageBase64 or mediaType', async () => {
    mockAuthed()

    const res = await POST(postRequest({ mediaType: 'image/jpeg' }))

    expect(res.status).toBe(400)
    expect(scanDataPlateImage).not.toHaveBeenCalled()
  })

  it('rejects an unsupported media type', async () => {
    mockAuthed()
    vi.mocked(isValidScanMediaType).mockReturnValue(false)

    const res = await POST(postRequest({ imageBase64: 'abc', mediaType: 'application/pdf' }))

    expect(res.status).toBe(400)
    expect(scanDataPlateImage).not.toHaveBeenCalled()
  })

  it('rejects an image over the 5 MB decoded-size limit', async () => {
    mockAuthed()
    // base64 length * 0.75 must exceed 5 * 1024 * 1024
    const hugeBase64 = 'A'.repeat(Math.ceil((5 * 1024 * 1024) / 0.75) + 100)

    const res = await POST(postRequest({ imageBase64: hugeBase64, mediaType: 'image/jpeg' }))

    expect(res.status).toBe(413)
    expect(scanDataPlateImage).not.toHaveBeenCalled()
  })

  it('scans the image and returns the extracted fields on the happy path', async () => {
    mockAuthed()
    const result = {
      make: 'Carrier', model: '25HCB636A003', serial_number: '1234ABCD',
      manufacture_year: 2019, capacity: '3 ton', confidence: 'high' as const,
    }
    vi.mocked(scanDataPlateImage).mockResolvedValue(result)

    const res = await POST(postRequest({ imageBase64: 'ZmFrZS1pbWFnZS1kYXRh', mediaType: 'image/jpeg' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual(result)
    expect(scanDataPlateImage).toHaveBeenCalledWith('ZmFrZS1pbWFnZS1kYXRh', 'image/jpeg')
  })
})
