import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/rate-limit', () => ({
  scanLimiter: { limit: vi.fn(async () => ({ success: true })) },
}))

import { POST } from '@/app/api/assets/request-scan/route'
import { createClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { scanLimiter } from '@/lib/rate-limit'

const USER_ID = 'user_1'
const ORG_ID  = 'org_1'

type ByTable = Record<string, { data: unknown; error?: unknown }>

// The route queries organization_members and crew_members in parallel, then
// property_assets once org id is resolved. Route to distinct chains by table.
function makeAuthClient(user: { id: string } | null, byTable: ByTable = {}) {
  const from = vi.fn((table: string) => {
    const result = byTable[table] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select      = vi.fn(() => chain)
    chain.eq          = vi.fn(() => chain)
    chain.not         = vi.fn(() => chain)
    chain.limit       = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.single       = vi.fn(() => Promise.resolve(result))
    return chain
  })

  return {
    auth: { getUser: vi.fn(async () => ({ data: { user } })) },
    from,
  }
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/assets/request-scan', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

const PHOTO_URL = 'https://xyz.supabase.co/storage/v1/object/public/turnover-photos/org_1/asset_1/plate.jpg'
const STORAGE_PATH = 'org_1/asset_1/plate.jpg'

function validBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    asset_id:     'asset_1',
    storage_path: STORAGE_PATH,
    media_type:   'image/jpeg',
    ...overrides,
  }
}

describe('POST /api/assets/request-scan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(scanLimiter.limit).mockResolvedValue({ success: true } as never)
  })

  it('rejects a body missing asset_id/storage_path/media_type before touching auth', async () => {
    const res = await POST(postRequest({ asset_id: 'asset_1' }))

    expect(res.status).toBe(400)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated request', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient(null) as never)

    const res = await POST(postRequest(validBody()))

    expect(res.status).toBe(401)
    expect(scanLimiter.limit).not.toHaveBeenCalled()
  })

  it('returns 429 and never queries the asset when the daily scan limit is exceeded', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient({ id: USER_ID }) as never)
    vi.mocked(scanLimiter.limit).mockResolvedValue({ success: false } as never)

    const res = await POST(postRequest(validBody()))

    expect(res.status).toBe(429)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('rejects a caller with neither an accepted org membership nor an active crew_members row', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, {
        organization_members: { data: null, error: null },
        crew_members:         { data: null, error: null },
      }) as never,
    )

    const res = await POST(postRequest(validBody()))

    expect(res.status).toBe(403)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('IDOR: returns 404 for an asset_id that does not belong to the caller\'s org (scoped lookup finds nothing)', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, {
        organization_members: { data: { org_id: ORG_ID }, error: null },
        crew_members:         { data: null, error: null },
        property_assets:      { data: null, error: null }, // .eq('org_id', orgId) found nothing
      }) as never,
    )

    const res = await POST(postRequest(validBody({ asset_id: 'other_org_asset' })))

    expect(res.status).toBe(404)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('rejects a storage_path that does not match the asset\'s own photo — blocks scanning an arbitrary object in the shared bucket', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, {
        organization_members: { data: { org_id: ORG_ID }, error: null },
        crew_members:         { data: null, error: null },
        property_assets:      { data: { id: 'asset_1', photo_url: PHOTO_URL, scan_status: null }, error: null },
      }) as never,
    )

    const res = await POST(postRequest(validBody({ storage_path: 'org_2/other_asset/secret-checklist-photo.jpg' })))

    expect(res.status).toBe(400)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('short-circuits without re-sending when a scan is already pending/processing for this asset', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, {
        organization_members: { data: { org_id: ORG_ID }, error: null },
        crew_members:         { data: null, error: null },
        property_assets:      { data: { id: 'asset_1', photo_url: PHOTO_URL, scan_status: 'processing' }, error: null },
      }) as never,
    )

    const res = await POST(postRequest(validBody()))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ success: true, alreadyQueued: true })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('resolves org via a crew_members identity when the caller has no organization_members row', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, {
        organization_members: { data: null, error: null },
        crew_members:         { data: { org_id: ORG_ID }, error: null },
        property_assets:      { data: { id: 'asset_1', photo_url: PHOTO_URL, scan_status: null }, error: null },
      }) as never,
    )

    const res = await POST(postRequest(validBody()))

    expect(res.status).toBe(200)
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'asset/scan_requested',
      data: { org_id: ORG_ID, asset_id: 'asset_1', storage_path: STORAGE_PATH, media_type: 'image/jpeg' },
    })
  })

  it('queues the scan on the happy path for a PM (organization_members) caller', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, {
        organization_members: { data: { org_id: ORG_ID }, error: null },
        crew_members:         { data: null, error: null },
        property_assets:      { data: { id: 'asset_1', photo_url: PHOTO_URL, scan_status: null }, error: null },
      }) as never,
    )

    const res = await POST(postRequest(validBody()))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ success: true })
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'asset/scan_requested',
      data: { org_id: ORG_ID, asset_id: 'asset_1', storage_path: STORAGE_PATH, media_type: 'image/jpeg' },
    })
  })
})
