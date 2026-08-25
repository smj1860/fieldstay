import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  safeFilename,
  reportFilename,
  photosRequested,
  reportResponse,
} from '@/lib/inspections/report/response'
import type { InspectionReport, ReportInspection } from '@/lib/inspections/report/model'

// ============================================================================
// THE THREE DOWNLOAD ROUTES.
//
// The owner route is the one that matters. It is unauthenticated, keyed by an
// id straight off the URL, and serves a document — which is the exact shape the
// standing checklist's IDOR item describes. Scoping the read to the token's ORG
// is NOT enough, and not in an edge case: an org holds every owner's
// properties, so an org-scoped lookup by inspection id hands one owner another
// owner's inspection at the same management company.
//
// The rest of this file is the packaging, where the interesting parts are a
// filename built from free text and going into a response header, and the fact
// that the owner route can never ask for photographs.
// ============================================================================

vi.mock('server-only', () => ({}))

// ── Filenames, which are free text in a header ──────────────────────────────

describe('safeFilename', () => {
  it('neutralizes the characters that would break out of the header', () => {
    // A property name is whatever the PM typed. `"` closes the quoted string,
    // `;` starts a new header parameter, and CR/LF splits the response — so
    // this is not cosmetics, it is the only thing between a property named
    // `x"; filename="passwd` and a header the browser reads differently.
    expect(safeFilename('x"; filename="passwd')).toBe('x-filename-passwd')
    expect(safeFilename('Lake\r\nHouse')).toBe('Lake-House')
    expect(safeFilename('../../etc/passwd')).toBe('etc-passwd')
  })

  it('still returns a usable name when the input sanitizes away entirely', () => {
    expect(safeFilename('🙂🙂🙂')).toBe('inspection-report')
    expect(safeFilename('')).toBe('inspection-report')
    expect(safeFilename('...')).toBe('inspection-report')
  })

  it('keeps an ordinary name readable', () => {
    expect(safeFilename('Cedar Point Lake House')).toBe('Cedar-Point-Lake-House')
  })

  it('bounds the length', () => {
    expect(safeFilename('a'.repeat(500)).length).toBeLessThanOrEqual(120)
  })

  it('truncates BEFORE sanitizing, so the work is bounded and not just the result', () => {
    // The original ran three regex passes over the whole input and sliced at
    // the end, so a pathological name paid full price before anything bounded
    // it — one pass being the `^[-.]+|[-.]+$` SonarQube flags as super-linear.
    //
    // THE INPUT HERE IS CHOSEN SO THE TWO ORDERINGS DISAGREE. A first attempt
    // used 500 'a's and checked the result was 120 long, which both orderings
    // satisfy — a blind assertion written while fixing blind assertions, caught
    // by canarying the fix. Sanitizing COLLAPSES runs, so a long run of
    // separators is where order becomes visible:
    //   truncate first  → 'x' + 119 spaces          → 'x-'  → trimmed → 'x'
    //   sanitize first  → 'x' + 200 spaces + 'y'    → 'x-y' → trimmed → 'x-y'
    expect(safeFilename(`x${' '.repeat(200)}y`)).toBe('x')
  })

  it('trims separators from both ends', () => {
    expect(safeFilename('--lake--house--')).toBe('lake-house')
    expect(safeFilename('.hidden')).toBe('hidden')
  })
})

const inspection = (over: Partial<ReportInspection> = {}): ReportInspection => ({
  id: 'i', propertyId: 'p', formKey: 'safety', formLabel: 'Safety & Risk Mitigation',
  formVersion: 3, header: null,
  startedAt: '2026-08-20T14:00:00.000Z', startedAtSource: 'server',
  completedAt: '2026-08-20T15:30:00.000Z', inspectorName: 'Dana Reed',
  sections: [], photosOnFile: 0, passCount: 0, failCount: 0, ...over,
})

const report = (over: Partial<InspectionReport> = {}): InspectionReport => ({
  orgId: 'o', propertyName: 'Cedar Point Lake House',
  generatedAt: '2026-08-25T12:00:00.000Z',
  inspections: [inspection()], photosIncluded: false, omittedCount: 0, ...over,
})

describe('reportFilename', () => {
  it('names a single inspection by property, form and COMPLETION date', () => {
    expect(reportFilename(report()))
      .toBe('Cedar-Point-Lake-House-Safety-Risk-Mitigation-2026-08-20.pdf')
  })

  it('names a history by property and generation date', () => {
    expect(reportFilename(report({ inspections: [inspection(), inspection()] })))
      .toBe('Cedar-Point-Lake-House-inspection-history-2026-08-25.pdf')
  })
})

describe('reportResponse', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46])

  it('is an attachment, with a sanitized filename', () => {
    const res = reportResponse(pdf, 'x"; filename="passwd.pdf')
    expect(res.headers.get('Content-Disposition'))
      .toBe('attachment; filename="x-filename-passwd.pdf"')
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
  })

  it('is never cached', () => {
    // The remediation column is a live join, so a cached copy would hand back
    // yesterday's statuses under today's generated-at stamp — the one
    // difference that stamp exists to make explainable.
    expect(reportResponse(pdf, 'a.pdf').headers.get('Cache-Control'))
      .toBe('private, no-store')
  })
})

describe('photosRequested', () => {
  it('defaults to including them — this is the PM parameter', () => {
    expect(photosRequested(new URL('https://x/api/inspections/1/report'))).toBe(true)
  })

  it('honours ?photos=0 so a PM can produce the copy an owner would get', () => {
    expect(photosRequested(new URL('https://x/r?photos=0'))).toBe(false)
    expect(photosRequested(new URL('https://x/r?photos=false'))).toBe(false)
  })

  it('can only ever NARROW — no value turns photographs on', () => {
    // There is no inverse parameter, because the owner route does not read this
    // function at all; it passes the literal `false`.
    expect(photosRequested(new URL('https://x/r?photos=1'))).toBe(true)
    expect(photosRequested(new URL('https://x/r?photos=yes'))).toBe(true)
  })
})

// ── The owner route ─────────────────────────────────────────────────────────

// Typed with a rest parameter so the forwarders below can spread into them.
// `vi.fn()` alone infers a zero-arg signature and the spread fails to compile.
type AnyFn = (...args: never[]) => unknown

const loadInspectionReport   = vi.fn<AnyFn>()
const renderInspectionReport = vi.fn<AnyFn>(
  () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46])))
const validatePortalToken    = vi.fn<AnyFn>()
const resolvePortalScope     = vi.fn<AnyFn>()
const logAuditEvent          = vi.fn<AnyFn>()

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))
vi.mock('next/server', () => ({ after: (fn: () => void) => fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: (...a: never[]) => logAuditEvent(...a) }))
vi.mock('@/lib/inspections/report/model', () => ({
  loadInspectionReport: (...a: never[]) => loadInspectionReport(...a),
}))
vi.mock('@/lib/inspections/report/render', () => ({
  renderInspectionReport: (...a: never[]) => renderInspectionReport(...a),
}))
vi.mock('@/lib/owner-portal/token', async () => {
  const actual = await vi.importActual<typeof import('@/lib/owner-portal/token')>(
    '@/lib/owner-portal/token',
  )
  return {
    ...actual,
    validatePortalToken: (...a: never[]) => validatePortalToken(...a),
    resolvePortalScope:  (...a: never[]) => resolvePortalScope(...a),
  }
})

const { GET: ownerGET } = await import('@/app/api/owner/[token]/inspections/[id]/report/route')

const ctx = (over: Partial<{ token: string; id: string }> = {}) =>
  ({ params: Promise.resolve({ token: 'tok', id: 'insp-1', ...over }) })

const req = () => new Request('https://x/api/owner/tok/inspections/insp-1/report')

beforeEach(() => {
  vi.clearAllMocks()
  validatePortalToken.mockResolvedValue({ ok: true, token: { id: 'ptok-1' } })
  resolvePortalScope.mockResolvedValue({
    orgId: 'org-1', ownerName: 'A. Owner',
    propertyIds: ['prop-mine'], properties: [],
  })
  loadInspectionReport.mockResolvedValue(report({
    orgId: 'org-1', inspections: [inspection({ id: 'insp-1', propertyId: 'prop-mine' })],
  }))
})

describe('owner report route — authorization', () => {
  it('serves the report for a property the token authorizes', async () => {
    const res = await ownerGET(req(), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
  })

  it('404s an inspection in the SAME ORG but another owner\'s property', async () => {
    // THE test in this file. An org holds every owner's properties, so the
    // org-scoped read succeeds here — it is the property check that has to
    // refuse. Without it, one owner downloads another owner's inspection at the
    // same management company by changing a uuid in the URL.
    loadInspectionReport.mockResolvedValue(report({
      orgId: 'org-1',
      inspections: [inspection({ id: 'insp-1', propertyId: 'prop-SOMEONE-ELSE' })],
    }))

    const res = await ownerGET(req(), ctx())
    expect(res.status).toBe(404)
    expect(renderInspectionReport).not.toHaveBeenCalled()
  })

  it('honours a multi-property token across all of its properties', async () => {
    resolvePortalScope.mockResolvedValue({
      orgId: 'org-1', ownerName: 'A. Owner',
      propertyIds: ['prop-a', 'prop-b'], properties: [],
    })
    loadInspectionReport.mockResolvedValue(report({
      orgId: 'org-1', inspections: [inspection({ propertyId: 'prop-b' })],
    }))

    expect((await ownerGET(req(), ctx())).status).toBe(200)
  })

  it.each([
    ['not_found', 'not_found'],
    ['revoked',   'revoked'],
    ['expired',   'expired'],
  ])('404s a %s token', async (_label, reason) => {
    validatePortalToken.mockResolvedValue({ ok: false, reason })
    const res = await ownerGET(req(), ctx())
    expect(res.status).toBe(404)
    expect(loadInspectionReport).not.toHaveBeenCalled()
  })

  it('gives ONE response for every rejection, so the id is not an oracle', async () => {
    // A caller who can tell "revoked token" from "wrong property" from "no such
    // inspection" can enumerate. The portal PAGE does distinguish revoked from
    // expired and should — a real owner at a dead link deserves to know which.
    // This is an id-keyed document endpoint and the audiences differ.
    const bodies: string[] = []

    validatePortalToken.mockResolvedValue({ ok: false, reason: 'revoked' })
    bodies.push(await (await ownerGET(req(), ctx())).text())

    validatePortalToken.mockResolvedValue({ ok: true, token: { id: 'ptok-1' } })
    loadInspectionReport.mockResolvedValue(null)
    bodies.push(await (await ownerGET(req(), ctx())).text())

    loadInspectionReport.mockResolvedValue(report({
      inspections: [inspection({ propertyId: 'prop-else' })],
    }))
    bodies.push(await (await ownerGET(req(), ctx())).text())

    expect(new Set(bodies).size).toBe(1)
  })

  it('404s when the token resolves to no scope at all', async () => {
    resolvePortalScope.mockResolvedValue(null)
    expect((await ownerGET(req(), ctx())).status).toBe(404)
    expect(loadInspectionReport).not.toHaveBeenCalled()
  })
})

describe('owner report route — photographs', () => {
  it('NEVER requests photographs, whatever the URL says', async () => {
    // The load-side decision from lib/inspections/report/model.ts: no signed URL
    // is minted and no object is read for an unauthenticated caller. Asserted
    // at the loader call, because that is where the private bucket is reached.
    await ownerGET(
      new Request('https://x/api/owner/tok/inspections/insp-1/report?photos=1'),
      ctx(),
    )
    expect(loadInspectionReport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includePhotos: false }),
    )
  })
})

describe('owner report route — audit', () => {
  it('records the download without any owner PII', async () => {
    await ownerGET(req(), ctx())

    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    const entry = logAuditEvent.mock.calls[0]![0] as Record<string, unknown>
    expect(entry.action).toBe('owner_portal.inspection_report.downloaded')
    expect(entry.targetId).toBe('ptok-1')

    // An audit row is for staff investigating an incident, not a second home
    // for data that should not be logged at all. The token id is enough.
    const serialized = JSON.stringify(entry)
    expect(serialized).not.toContain('A. Owner')
    expect(serialized).not.toContain('Cedar Point')
  })

  it('does not record a download that was refused', async () => {
    loadInspectionReport.mockResolvedValue(report({
      inspections: [inspection({ propertyId: 'prop-else' })],
    }))
    await ownerGET(req(), ctx())
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
