import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => undefined) }))

import { revealAccessForPortal } from '@/lib/work-orders/access'
import { reportError } from '@/lib/observability/report-error'
import { logAuditEvent } from '@/lib/audit'

function makeSupabase(rpcResult: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn(() => Promise.resolve(rpcResult))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { rpc } as any, rpc }
}

const ACCEPTED = {
  workOrderId: 'wo_1', orgId: 'org_1', propertyId: 'prop_1',
  vendorAcceptedAt: '2026-10-12T00:00:00Z',
  accessNotes: 'Lockbox on the back gate', parkingNotes: 'Use the driveway',
}

const VENDOR = { kind: 'vendor' as const, grantId: null, displayName: null }
const TECH = { kind: 'technician' as const, grantId: 'grant_1', displayName: 'Mike' }

beforeEach(() => vi.clearAllMocks())

describe('revealAccessForPortal: the gate', () => {
  it('reveals nothing, and makes NO rpc call, before acceptance', async () => {
    // The RPC not firing is the assertion that matters. A component that
    // renders the code behind a condition still receives it in the serialised
    // payload, readable from the page source, so the gate has to stop the READ
    // rather than the render.
    const { client, rpc } = makeSupabase({ data: '4821', error: null })

    await expect(revealAccessForPortal(client, { ...ACCEPTED, vendorAcceptedAt: null }, VENDOR))
      .resolves.toEqual({ revealed: false, reason: 'not_accepted' })

    expect(rpc).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('reveals the code once accepted', async () => {
    const { client, rpc } = makeSupabase({ data: '4821', error: null })

    await expect(revealAccessForPortal(client, ACCEPTED, VENDOR)).resolves.toEqual({
      revealed: true,
      details: {
        doorCode:     '4821',
        accessNotes:  'Lockbox on the back gate',
        parkingNotes: 'Use the driveway',
      },
    })

    // The existing Vault-backed RPC, not a new plaintext column.
    expect(rpc).toHaveBeenCalledWith('read_property_door_code', {
      p_property_id: 'prop_1',
      p_org_id:      'org_1',
    })
  })

  it('reports nothing_on_file when accepted but the PM recorded nothing', async () => {
    // Distinguished from not_accepted so the UI can say "contact them before
    // you go" rather than "these appear once you accept", which would be a lie.
    const { client } = makeSupabase({ data: null, error: null })
    await expect(revealAccessForPortal(
      client,
      { ...ACCEPTED, accessNotes: null, parkingNotes: null },
      VENDOR,
    )).resolves.toEqual({ revealed: false, reason: 'nothing_on_file' })
  })

  it('still shows the notes when there is no code on file', async () => {
    const { client } = makeSupabase({ data: null, error: null })
    const result = await revealAccessForPortal(client, ACCEPTED, VENDOR)
    expect(result).toMatchObject({ revealed: true })
    if (!result.revealed) return
    expect(result.details.doorCode).toBeNull()
    expect(result.details.accessNotes).toBe('Lockbox on the back gate')
  })

  it('treats an empty-string code as absent', async () => {
    // So the UI never renders a labelled blank where a code should be.
    const { client } = makeSupabase({ data: '', error: null })
    const result = await revealAccessForPortal(client, ACCEPTED, VENDOR)
    if (!result.revealed) throw new Error('expected a reveal')
    expect(result.details.doorCode).toBeNull()
  })

  it('degrades to the notes when the decrypt fails, rather than breaking the page', async () => {
    // The vendor is standing at a door. Notes without a code beat a broken
    // page, and the PM's number is on the work order either way.
    const { client } = makeSupabase({ data: null, error: { message: 'vault unavailable' } })

    const result = await revealAccessForPortal(client, ACCEPTED, VENDOR)
    expect(result).toMatchObject({ revealed: true })
    if (!result.revealed) return
    expect(result.details.doorCode).toBeNull()

    // At error level: a code that cannot be decrypted is a fault, not a
    // degradation.
    expect(reportError).toHaveBeenCalledWith(
      { message: 'vault unavailable' },
      expect.objectContaining({ orgId: 'org_1' }),
    )
    const ctx = (reportError as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>
    expect(ctx.level).toBeUndefined()
  })
})

describe('revealAccessForPortal: the audit trail', () => {
  it('records who was shown the code, and never the code itself', async () => {
    const { client } = makeSupabase({ data: '4821', error: null })
    await revealAccessForPortal(client, ACCEPTED, TECH)

    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    const row = (logAuditEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>

    expect(row).toMatchObject({
      orgId:      'org_1',
      action:     'work_order.access_revealed',
      targetType: 'work_order',
      targetId:   'wo_1',
    })

    // Names a PERSON, not only the company: that is what the grant label is
    // for, and what makes the row answer "who".
    expect(row.metadata).toMatchObject({
      viewer_kind:   'technician',
      grant_id:      'grant_1',
      viewer_name:   'Mike',
      included_code: true,
    })

    // Audit rows are read by staff investigating an incident, not a second
    // home for data that should not be logged at all.
    expect(JSON.stringify(row)).not.toContain('4821')
  })

  it('records a reveal with no code as not including one', async () => {
    const { client } = makeSupabase({ data: null, error: null })
    await revealAccessForPortal(client, ACCEPTED, VENDOR)

    const row = (logAuditEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>
    expect(row.metadata).toMatchObject({ viewer_kind: 'vendor', included_code: false })
  })

  it('writes no row when nothing was shown', async () => {
    // Logging an empty block would bury the rows that matter.
    const { client } = makeSupabase({ data: null, error: null })
    await revealAccessForPortal(
      client,
      { ...ACCEPTED, accessNotes: null, parkingNotes: null },
      VENDOR,
    )
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
