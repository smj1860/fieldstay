import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/helpers', () => ({ getPmEmails: vi.fn(async () => ['pm@example.com']) }))
vi.mock('@/lib/evidence/packet/model', () => ({ loadPacketModel: vi.fn() }))
vi.mock('@/lib/evidence/packet/render', () => ({ renderClaimPacket: vi.fn() }))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn(async () => ({})) } },
  FROM: 'FieldStay <noreply@example.com>',
  sendWithTimeout: async <T,>(send: () => Promise<T>) => send(),
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({ renderPmAlert: vi.fn(async () => '<p>x</p>') }))

import { evidencePacket, sniffFormat, markPacketFailed, failedPacketTarget } from '@/lib/inngest/functions/evidence-packet'
import { createServiceClient } from '@/lib/supabase/server'
import { loadPacketModel } from '@/lib/evidence/packet/model'
import { renderClaimPacket } from '@/lib/evidence/packet/render'
import { resend } from '@/lib/resend/client'
import { invokeHandler } from './test-helpers'

const ORG = '11111111-1111-4111-8111-111111111111'
const DATA = { org_id: ORG, booking_id: 'b1', packet_id: 'p1', requested_by: 'u1', requested_at_ms: 1_700_000_000_000, event_ids: null }

interface Stub { uploads: { path: string }[]; milestones: Record<string, unknown>[]; ledger: Record<string, unknown>[] }

function stub(over: { uploadError?: unknown; ledgerError?: { code: string } } = {}): Stub {
  const state: Stub = { uploads: [], milestones: [], ledger: [] }
  vi.mocked(createServiceClient).mockReturnValue({
    storage: { from: () => ({ upload: async (path: string) => { state.uploads.push({ path }); return { error: over.uploadError ?? null } } }) },
    from: (table: string) => {
      if (table === 'bookings') return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { property_id: 'prop1' }, error: null }) }) }) }) }
      if (table === 'org_milestones') return { upsert: async (row: Record<string, unknown>) => { state.milestones.push(row); return { error: null } } }
      if (table === 'evidence_events') return {
        insert: (row: Record<string, unknown>) => { state.ledger.push(row); return { select: () => ({ single: async () =>
          over.ledgerError ? { data: null, error: over.ledgerError } : { data: { id: 'ledger1' }, error: null } }) } },
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'ledger-existing' }, error: null }) }) }) }) }) }),
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as never)
  return state
}

const model = { repairs: [], repairsCapNote: null, omittedCount: 0, pairs: [{ before: { id: 'x' }, after: { id: 'y' } }], others: [], custody: [{ id: 'x' }, { id: 'y' }] }
const run = () => invokeHandler(evidencePacket, { event: { data: DATA }, step: { run: async (_n: string, cb: () => unknown) => cb() } })

describe('sniffFormat', () => {
  it('trusts magic bytes, not the file extension', () => {
    expect(sniffFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(sniffFormat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png')
    expect(sniffFormat(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]))).toBeNull()   // WebP
    expect(sniffFormat(new Uint8Array())).toBeNull()
  })
})

describe('evidencePacket', () => {
  beforeEach(() => {
    vi.mocked(loadPacketModel).mockReset().mockResolvedValue(model as never)
    vi.mocked(renderClaimPacket).mockReset().mockResolvedValue(new Uint8Array([37, 80, 68, 70]))
    vi.mocked(resend.emails.send).mockClear()
  })

  it('renders, uploads under the org prefix, records the hash in the ledger, completes the milestone and emails once', async () => {
    const s = stub()
    const out = await run()
    expect(out).toMatchObject({ ok: true, event_id: 'ledger1', photos: 2 })
    expect(s.uploads[0].path.startsWith(`${ORG}/`)).toBe(true)
    expect(s.uploads[0].path.endsWith('p1.pdf')).toBe(true)
    expect(s.ledger[0]).toMatchObject({
      kind: 'packet_generated', source_table: 'evidence_packets', bucket: 'evidence-packets', source_id: 'p1',
      property_id: 'prop1', hash_verified: true,
    })
    expect(s.ledger[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(s.milestones.at(-1)).toMatchObject({ milestone: 'evidence_packet_p1', value: { status: 'ready', event_id: 'ledger1' } })
    expect(vi.mocked(resend.emails.send).mock.calls[0][1]).toEqual({ idempotencyKey: 'evidence-packet-ledger1' })
  })

  it('marks the packet failed when the booking is gone', async () => {
    vi.mocked(loadPacketModel).mockResolvedValue(null)
    const s = stub()
    expect(await run()).toEqual({ ok: false, reason: 'booking_not_found' })
    expect(s.milestones.at(-1)).toMatchObject({ value: { status: 'failed' } })
    expect(s.ledger).toHaveLength(0)
  })

  it('rethrows an upload failure WITHOUT marking the milestone failed (retries may still succeed), writing no ledger row', async () => {
    const s = stub({ uploadError: { message: 'storage down' } })
    await expect(run()).rejects.toBeTruthy()
    expect(s.milestones.some((m) => (m.value as { status: string }).status === 'failed')).toBe(false)
    expect(s.ledger).toHaveLength(0)
  })

  it('onFailure marks the milestone failed from the original event, and tolerates an unreadable payload', async () => {
    const s = stub()
    await markPacketFailed({ data: { event: { data: DATA } } })
    expect(s.milestones.at(-1)).toMatchObject({ milestone: 'evidence_packet_p1', value: { status: 'failed' } })
    const before = s.milestones.length
    await markPacketFailed({ data: {} })
    expect(s.milestones).toHaveLength(before)
    expect(failedPacketTarget(null)).toBeNull()
  })

  it('recovers the existing ledger row when the insert replays (23505)', async () => {
    stub({ ledgerError: { code: '23505' } })
    expect(await run()).toMatchObject({ ok: true, event_id: 'ledger-existing' })
  })
})
