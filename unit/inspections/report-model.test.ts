import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  loadInspectionReport,
  MAX_HISTORY_INSPECTIONS,
} from '@/lib/inspections/report/model'

// ============================================================================
// THE EXPORTED REPORT'S DATA MODEL.
//
// Four things carry weight here and the rest is assembly.
//
// TENANT SCOPE, because the single-inspection shape is keyed by an id straight
// off a URL. `requireOrgMember()` proves the caller belongs to AN org; only the
// `.eq('org_id', …)` below proves this document is theirs.
//
// PHOTOS ARE NEVER FETCHED FOR THE OWNER. @smj1860: "the photos only the pm".
// `includePhotos: false` must mean no object is read at all — not read-then-
// discarded, which would leave the private bucket one renderer bug from a
// token-holder. Asserted against the storage client, not against the output.
//
// COMPLETED ONLY. A downloadable PDF of a half-filled form is the most damaging
// version of an in-progress walk leaking, because it looks finished.
//
// AND IT THROWS. The portal degrades to a missing section; a download cannot.
// A PDF quietly missing half its answers is indistinguishable from a walk where
// half the items were skipped.
// ============================================================================

const ORG = 'org-1'
const NOW = '2026-08-25T12:00:00.000Z'

interface Spec { data?: unknown; error?: { message: string } | null; count?: number }

interface Call { table: string; method: string; args: unknown[] }

function makeClient(tables: Record<string, Spec>, downloads: Record<string, Uint8Array> = {}) {
  const calls: Call[] = []
  const downloaded: string[] = []

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      const methods = ['select', 'eq', 'in', 'is', 'not', 'lte', 'order', 'limit', 'range']
      for (const m of methods) {
        builder[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return builder }
      }
      const result = () => ({
        data:  tables[table]?.data ?? [],
        error: tables[table]?.error ?? null,
        count: tables[table]?.count,
      })
      builder.maybeSingle = () => {
        calls.push({ table, method: 'maybeSingle', args: [] })
        const r = result()
        return Promise.resolve({
          ...r,
          data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
        })
      }
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve)
      return builder
    },
    storage: {
      from(bucket: string) {
        return {
          download(path: string) {
            downloaded.push(`${bucket}:${path}`)
            const bytes = downloads[path]
            if (!bytes) return Promise.resolve({ data: null, error: { message: 'not found' } })
            return Promise.resolve({
              data:  { arrayBuffer: () => Promise.resolve(bytes.buffer) },
              error: null,
            })
          },
        }
      },
    },
  } as unknown as SupabaseClient

  return { client, calls, downloaded }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const snapshot = (over: Record<string, unknown> = {}) => ({
  form_key:     'safety',
  form_version: 3,
  captured_at:  '2026-08-01T00:00:00.000Z',
  sections: [
    {
      id: 'sec-1', key: 'detectors', name: 'Detectors', sort_order: 1, shown_when_asset: null,
      items: [
        { id: 'fi-1', remediation: 'work_order', sort_order: 1 },
        { id: 'fi-2', remediation: 'work_order', sort_order: 2 },
      ],
    },
    {
      id: 'sec-2', key: 'security', name: 'Security', sort_order: 2, shown_when_asset: null,
      items: [
        { id: 'fi-3', remediation: 'none', sort_order: 1 },
      ],
    },
  ],
  ...over,
})

const inspectionRow = (over: Record<string, unknown> = {}) => ({
  id:              'insp-1',
  property_id:     'prop-1',
  form_version:    3,
  form_snapshot:   snapshot(),
  header_snapshot: { property_name: 'Lake House', property_address: '12 Oak St' },
  started_at:      '2026-08-20T14:00:00.000Z',
  started_at_source: 'server',
  completed_at:    '2026-08-20T15:30:00.000Z',
  inspector_name:  'Dana Reed',
  property:        [{ name: 'Lake House' }],
  ...over,
})

const answer = (over: Record<string, unknown> = {}) => ({
  id:            'ans-1',
  inspection_id: 'insp-1',
  form_item_id:  'fi-1',
  prompt_snapshot: 'Smoke detectors present and functioning',
  result:        'pass',
  value_number:  null,
  value_text:    null,
  value_date:    null,
  note:          null,
  na_reason:     null,
  actions:       [],
  needs_cleaning: false,
  photo_path:    null,
  photo_unavailable_reason: null,
  ...over,
})

const baseTables = (over: Record<string, Spec> = {}): Record<string, Spec> => ({
  inspections:     { data: [inspectionRow()] },
  inspection_items: { data: [answer()] },
  work_orders:     { data: [] },
  purchase_orders: { data: [] },
  ...over,
})

// ── Tenant scope and completion ─────────────────────────────────────────────

describe('loadInspectionReport — scope', () => {
  it('scopes the SINGLE-inspection read to the org, not just to the id', async () => {
    // The id comes off a URL. Without this filter, any PM could download any
    // tenant's inspection by guessing a uuid — org membership alone does not
    // prove the object is theirs.
    const { client, calls } = makeClient(baseTables())
    await loadInspectionReport(client, { orgId: ORG, inspectionId: 'insp-1', includePhotos: false })

    const args = calls.filter((c) => c.table === 'inspections').map((c) => c.args)
    expect(args).toContainEqual(['org_id', ORG])
    expect(args).toContainEqual(['id', 'insp-1'])
  })

  it('scopes the PROPERTY-history read to the org as well', async () => {
    const { client, calls } = makeClient(baseTables())
    await loadInspectionReport(client, { orgId: ORG, propertyId: 'prop-1', includePhotos: false })

    const args = calls.filter((c) => c.table === 'inspections').map((c) => c.args)
    expect(args).toContainEqual(['org_id', ORG])
    expect(args).toContainEqual(['property_id', 'prop-1'])
  })

  it('scopes the ANSWER read to the org too', async () => {
    // inspection_items carries its own org_id. Scoping only the parent read
    // would leave the child read relying on the id list being trustworthy,
    // which is a weaker guarantee than simply filtering.
    const { client, calls } = makeClient(baseTables())
    await loadInspectionReport(client, { orgId: ORG, inspectionId: 'insp-1', includePhotos: false })

    expect(calls.filter((c) => c.table === 'inspection_items').map((c) => c.args))
      .toContainEqual(['org_id', ORG])
  })

  it('excludes an in-progress walk in BOTH shapes', async () => {
    for (const input of [
      { orgId: ORG, inspectionId: 'insp-1', includePhotos: false },
      { orgId: ORG, propertyId: 'prop-1',   includePhotos: false },
    ]) {
      const { client, calls } = makeClient(baseTables())
      await loadInspectionReport(client, input)
      expect(
        calls.some((c) => c.table === 'inspections' && c.method === 'not'
          && c.args[0] === 'completed_at' && c.args[1] === 'is' && c.args[2] === null),
        'a completed_at IS NOT NULL filter must be present',
      ).toBe(true)
    }
  })

  it('returns null when nothing matches, rather than an empty document', async () => {
    const { client } = makeClient(baseTables({ inspections: { data: [] } }))
    expect(await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'nope', includePhotos: false,
    })).toBeNull()
  })
})

// ── Photos are a load decision ──────────────────────────────────────────────

describe('loadInspectionReport — photos', () => {
  const withPhoto = baseTables({
    inspection_items: { data: [answer({ photo_path: 'org-1/insp-1/a.jpg' })] },
  })
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02])

  it('NEVER touches storage when includePhotos is false', async () => {
    // The assertion that matters. Loading photos and letting the renderer drop
    // them would put the private bucket one renderer bug away from an
    // unauthenticated token-holder, and that bug looks like a PDF with an extra
    // page — invisible in review.
    const { client, downloaded } = makeClient(withPhoto, { 'org-1/insp-1/a.jpg': JPEG })
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })

    expect(downloaded).toEqual([])
    expect(report!.photosIncluded).toBe(false)
    expect(report!.inspections[0]!.sections.flatMap((s) => s.answers).every((a) => a.photo === null))
      .toBe(true)
  })

  it('downloads from the private bucket when includePhotos is true', async () => {
    const { client, downloaded } = makeClient(withPhoto, { 'org-1/insp-1/a.jpg': JPEG })
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: true,
    })

    expect(downloaded).toEqual(['inspection-photos:org-1/insp-1/a.jpg'])
    const [first] = report!.inspections[0]!.sections[0]!.answers
    expect(first!.photo).toMatchObject({ path: 'org-1/insp-1/a.jpg', format: 'jpeg' })
  })

  it('SKIPS a photo that fails to download instead of losing the document', async () => {
    // A missing photograph costs one page of corroboration. A throw costs every
    // finding on the report.
    const { client } = makeClient(withPhoto, {})   // download returns an error
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: true,
    })

    expect(report).not.toBeNull()
    expect(report!.inspections[0]!.sections[0]!.answers[0]!.photo).toBeNull()
  })

  it('classifies by MAGIC BYTES, so a non-JPEG cannot throw inside the render', async () => {
    // pdf-lib embeds JPEG and PNG only, and throws on anything else — which
    // would take the whole document down over one photograph. The bucket also
    // allows HEIC and WebP.
    const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
    const png  = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    for (const [bytes, expected] of [[heic, 'unsupported'], [png, 'png']] as const) {
      const { client } = makeClient(withPhoto, { 'org-1/insp-1/a.jpg': bytes })
      const report = await loadInspectionReport(client, {
        orgId: ORG, inspectionId: 'insp-1', includePhotos: true,
      })
      expect(report!.inspections[0]!.sections[0]!.answers[0]!.photo!.format).toBe(expected)
    }
  })
})

// ── Record-only items ───────────────────────────────────────────────────────

describe('loadInspectionReport — record-only items', () => {
  const tables = baseTables({
    inspection_items: {
      data: [
        answer({ id: 'ans-1', form_item_id: 'fi-1', result: 'pass' }),
        answer({ id: 'ans-3', form_item_id: 'fi-3', result: 'fail',
          prompt_snapshot: 'Monitored alarm or security system present' }),
      ],
    },
    // A cleaning roll-up exists on this walk, keyed to the INSPECTION.
    work_orders: {
      data: [{
        wo_number: 'WO-2026-0031', status: 'open',
        source_inspection_item_id: null, source_inspection_id: 'insp-1',
      }],
    },
  })

  it('PRINTS them — unlike the portal, which drops them', async () => {
    // A PDF is the evidentiary artifact and "no alarm system present" is
    // exactly what an insurer asks about. The portal is a phone summary where
    // the same line reads as a complaint.
    const { client } = makeClient(tables)
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })

    const all = report!.inspections[0]!.sections.flatMap((s) => s.answers)
    const alarm = all.find((a) => a.prompt.includes('alarm'))
    expect(alarm).toBeDefined()
    expect(alarm!.isRecordOnly).toBe(true)
  })

  it('counts them as neither a pass nor a fail', async () => {
    const { client } = makeClient(tables)
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })

    // fi-3 answered 'fail' — but it is a fact, not a failed check.
    expect(report!.inspections[0]!.passCount).toBe(1)
    expect(report!.inspections[0]!.failCount).toBe(0)
  })

  it('never attributes the walk roll-up to one', async () => {
    // The roll-up is keyed on the INSPECTION, so a naive lookup would print
    // "WO-2026-0031, open" against "no alarm system present" — asserting work
    // was raised for a question whose honest answer was simply no.
    const { client } = makeClient(tables)
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })

    const alarm = report!.inspections[0]!.sections
      .flatMap((s) => s.answers).find((a) => a.prompt.includes('alarm'))
    expect(alarm!.remediation).toEqual({ kind: 'none' })
  })

  it('classifies PER INSPECTION, so a reclassified item reads as it was walked', async () => {
    // Each walk carries its own snapshot. A single merged set would let a later
    // walk's classification rewrite an earlier walk's report — the exact thing
    // form_snapshot exists to prevent.
    const reclassified = snapshot({
      sections: [{
        id: 'sec-2', key: 'security', name: 'Security', sort_order: 1, shown_when_asset: null,
        items: [{ id: 'fi-3', remediation: 'work_order', sort_order: 1 }],
      }],
    })

    const { client } = makeClient({
      inspections: {
        data: [
          inspectionRow({ id: 'insp-2', completed_at: '2026-08-21T10:00:00.000Z',
            form_snapshot: reclassified }),
          inspectionRow({ id: 'insp-1' }),
        ],
        count: 2,
      },
      inspection_items: {
        data: [
          answer({ id: 'ans-old', inspection_id: 'insp-1', form_item_id: 'fi-3', result: 'fail' }),
          answer({ id: 'ans-new', inspection_id: 'insp-2', form_item_id: 'fi-3', result: 'fail' }),
        ],
      },
      work_orders: { data: [] }, purchase_orders: { data: [] },
    })

    const report = await loadInspectionReport(client, {
      orgId: ORG, propertyId: 'prop-1', includePhotos: false,
    })

    const byId = new Map(report!.inspections.map((i) => [i.id, i]))
    // insp-2 walked it as a real check; insp-1 walked it as a fact.
    expect(byId.get('insp-2')!.failCount).toBe(1)
    expect(byId.get('insp-1')!.failCount).toBe(0)
  })
})

// ── Assembly ────────────────────────────────────────────────────────────────

describe('loadInspectionReport — assembly', () => {
  it('walks the SNAPSHOT order, not the order the answer rows came back', async () => {
    // `.order('id')` on the answer read is a pagination requirement — pages are
    // only stable under a stable sort — and says nothing about the order the
    // form was filled in. The snapshot is what records that.
    const { client } = makeClient(baseTables({
      inspection_items: {
        data: [
          answer({ id: 'ans-b', form_item_id: 'fi-2', prompt_snapshot: 'Second' }),
          answer({ id: 'ans-a', form_item_id: 'fi-1', prompt_snapshot: 'First'  }),
        ],
      },
    }))
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })

    expect(report!.inspections[0]!.sections[0]!.answers.map((a) => a.prompt))
      .toEqual(['First', 'Second'])
  })

  it('omits an UNANSWERED item rather than printing it blank', async () => {
    // Every item on a completed walk was answered or gated off by a condition
    // it did not meet. A blank row cannot tell a reader which, so it reads as
    // something skipped.
    const { client } = makeClient(baseTables())
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })

    const prompts = report!.inspections[0]!.sections.flatMap((s) => s.answers)
    expect(prompts).toHaveLength(1)   // only fi-1 was answered
  })

  it('still produces a document when the snapshot is malformed', async () => {
    // The answers are the record; the headings are navigation. Losing the
    // headings and keeping every finding is the right way round.
    const { client } = makeClient(baseTables({
      inspections: { data: [inspectionRow({ form_snapshot: { garbage: true } })] },
    }))
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })

    expect(report!.inspections[0]!.sections).toHaveLength(1)
    expect(report!.inspections[0]!.sections[0]!.answers).toHaveLength(1)
  })

  it('keeps 0 and the empty string as real answers', async () => {
    // "0 fire extinguishers" is the finding, not a missing value.
    const { client } = makeClient(baseTables({
      inspection_items: {
        data: [
          answer({ id: 'a', form_item_id: 'fi-1', result: null, value_number: 0 }),
          answer({ id: 'b', form_item_id: 'fi-2', result: null, value_text: '' }),
        ],
      },
    }))
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })

    const values = report!.inspections[0]!.sections[0]!.answers.map((a) => a.value)
    expect(values).toEqual(['0', ''])
  })

  it('carries started_at WITH its source, so a device clock is not laundered', async () => {
    // §8 records that a walk can be started offline, in which case started_at
    // is a device clock corrected by measured skew. The spec's phase-7 row says
    // "server-stamped", which is true of the alternatives it ruled out and not
    // of every row. The renderer needs to be able to say which.
    const { client } = makeClient(baseTables({
      inspections: { data: [inspectionRow({ started_at_source: 'device' })] },
    }))
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })

    expect(report!.inspections[0]!.startedAtSource).toBe('device')
  })

  it('reports how many walks the history cap left out', async () => {
    // A cap that is not stated turns "the most recent 60" into an assertion of
    // completeness — on a document whose entire claim is completeness.
    const { client } = makeClient(baseTables({
      inspections: { data: [inspectionRow()], count: 106 },
    }))
    const report = await loadInspectionReport(client, {
      orgId: ORG, propertyId: 'prop-1', includePhotos: false,
    })

    expect(report!.omittedCount).toBe(105)
    expect(MAX_HISTORY_INSPECTIONS).toBe(60)
  })

  it('stamps generated-at, because remediation status is a live join', async () => {
    const { client } = makeClient(baseTables())
    const report = await loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false, now: NOW,
    })
    expect(report!.generatedAt).toBe(NOW)
  })
})

// ── Failure posture ─────────────────────────────────────────────────────────

describe('loadInspectionReport — a failed read is not an empty walk', () => {
  it('THROWS when the inspection read errors', async () => {
    const { client } = makeClient(baseTables({
      inspections: { error: { message: 'connection reset' } },
    }))
    await expect(loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })).rejects.toThrow()
  })

  it('THROWS when the ANSWER read errors', async () => {
    // The dangerous one. A report that renders its letterhead, its sign-off and
    // zero findings is a clean bill of health for a walk nobody can vouch for.
    const { client } = makeClient(baseTables({
      inspection_items: { error: { message: 'timeout' } },
    }))
    await expect(loadInspectionReport(client, {
      orgId: ORG, inspectionId: 'insp-1', includePhotos: false,
    })).rejects.toThrow()
  })
})

vi.mock('server-only', () => ({}))
