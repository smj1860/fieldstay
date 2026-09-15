import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', async () => {
  const { checkLimitStub, retryAfterSecondsStub } = await import('@/unit/stubs/rate-limit')
  return {
    dataExportLimiter: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:        checkLimitStub(),
    retryAfterSeconds: retryAfterSecondsStub,
  }
})
vi.mock('@/lib/auth', () => ({ requireOrgMember: vi.fn() }))
vi.mock('@/lib/history/loadPropertyHistory', () => ({ loadPropertyHistory: vi.fn() }))

import { GET } from '@/app/api/properties/[id]/history/export/route'
import { requireOrgMember } from '@/lib/auth'
import { loadPropertyHistory } from '@/lib/history/loadPropertyHistory'
import type { PropertyHistoryEvent } from '@/lib/history/loadPropertyHistory'

// ============================================================================
// CSV/formula injection: csvField() only escaped embedded double-quotes, so a
// field starting with =, +, -, or @ opened as a live formula the moment a PM
// double-clicked the exported CSV in Excel/Sheets/LibreOffice. Every field
// here (title, detail, actorName) is free text a crew member controls
// (checklist notes, WO descriptions, assignment context) — a known,
// real-world attack class (CSV/DDE injection), not a hypothetical.
// ============================================================================

const ORG_ID      = 'org_1'
const PROPERTY_ID = 'prop_1'

function makeSupabase() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select = vi.fn(() => chain)
  chain.eq     = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: { id: PROPERTY_ID, name: 'Cabin One' }, error: null }))
  return { from: vi.fn(() => chain) }
}

function mockAuthed() {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user:       { id: 'user_1' } as never,
    supabase:   makeSupabase() as never,
    membership: { org_id: ORG_ID, role: 'admin', org: {} as never },
  } as never)
}

function getRequest(query = '') {
  return new Request(`http://localhost/api/properties/${PROPERTY_ID}/history/export${query}`) as never
}

function params() {
  return { params: Promise.resolve({ id: PROPERTY_ID }) }
}

function event(over: Partial<PropertyHistoryEvent> = {}): PropertyHistoryEvent {
  return {
    type: 'work_order_update', occurredAt: '2026-08-01T12:00:00.000Z',
    title: 'Work order updated', detail: null, actorName: null, photoStoragePath: null,
    ...over,
  }
}

describe('GET /api/properties/[id]/history/export — CSV/formula injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthed()
  })

  it.each([
    {
      label:            'defangs a leading = with a single quote inside the quotes, neutralizing an Excel/Sheets formula',
      title:            '=HYPERLINK("http://evil.example/","click")',
      // Quoted and escaped, but the leading = must be defanged with a
      // leading single quote INSIDE the quotes — a real spreadsheet still
      // treats a raw ="..." field as live even when CSV-quoted.
      expectContain:    '"\'=HYPERLINK(""http://evil.example/"",""click"")"',
      expectNotContain: '"=HYPERLINK(',
    },
    {
      label:            'leaves an ordinary field untouched, still just double-quote-escaped',
      title:            'Replaced the "leaky" faucet',
      expectContain:    '"Replaced the ""leaky"" faucet"',
      expectNotContain: "'Replaced",
    },
    {
      label:            'does not touch a field that merely CONTAINS = later in the string',
      title:            'Cost = $40',
      expectContain:    '"Cost = $40"',
      expectNotContain: "'Cost",
    },
  ])('$label', async ({ title, expectContain, expectNotContain }) => {
    vi.mocked(loadPropertyHistory).mockResolvedValue({
      events: [event({ title })],
      totalCount: 1, omittedCount: 0,
    })

    const res = await GET(getRequest(), params())
    const csv = await res.text()

    expect(csv).toContain(expectContain)
    expect(csv).not.toContain(expectNotContain)
  })

  it.each(['+', '-', '@', '\t', '\r'])('neutralizes a leading %s the same way', async (trigger) => {
    vi.mocked(loadPropertyHistory).mockResolvedValue({
      events: [event({ detail: `${trigger}cmd|'/C calc'!A1` })],
      totalCount: 1, omittedCount: 0,
    })

    const res = await GET(getRequest(), params())
    const csv = await res.text()

    expect(csv).toContain(`'${trigger}cmd`)
  })
})
