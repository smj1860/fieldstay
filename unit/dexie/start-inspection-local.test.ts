import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDashboardDb, getDashboardDb } from '@/lib/dexie/dashboard/schema'
import { startInspectionLocally } from '@/lib/dexie/dashboard/start-inspection-local'
import { parseFormSnapshot } from '@/lib/inspections/snapshots'
import type { InspectionForm, InspectionFormItem, InspectionFormSection, Property } from '@/types/database'

// ============================================================================
// STARTING A WALK WITH NO SIGNAL.
//
// This is the only start path — online it drains within a second and behaves
// exactly as the Server Action it replaced. Two implementations would have
// meant the offline one being the one nobody exercises at a desk.
//
// The invariant that matters most here is that a PARTIAL cache must refuse,
// loudly. A form whose items did not download would resolve to a SHORTER walk:
// the inspector answers every question shown, the Review gate passes, and a
// whole section is silently absent from a document handed to an insurer.
// ============================================================================

const USER = '11111111-2222-3333-4444-555555555555'
const ORG  = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const form = (over: Partial<InspectionForm> = {}): InspectionForm => ({
  id: 'form-1', key: 'safety', name: 'Safety', kind: 'safety', description: null,
  version: 1, is_active: true, created_at: '2026-01-01T00:00:00Z',
  ...over,
} as InspectionForm)

const section = (over: Partial<InspectionFormSection> = {}): InspectionFormSection => ({
  id: 'sec-1', form_id: 'form-1', key: 'fire', name: 'Fire', sort_order: 0,
  shown_when_asset: null, created_at: '2026-01-01T00:00:00Z',
  ...over,
})

const item = (over: Partial<InspectionFormItem> = {}): InspectionFormItem => ({
  id: 'item-1', section_id: 'sec-1', key: 'fire.a', prompt: 'Detectors present',
  sort_order: 0, response_type: 'yes_no', is_required: true, photo_required: false,
  parent_item_id: null, show_when: null, repeat_source_item_id: null,
  repeat_per_asset: false, per_unit: false,
  na_reason_template: null, na_asset_type: null, asset_type: null,
  concern_key: null, remediation: 'work_order', default_actions: ['repair'],
  wo_category: null, wo_priority: null, po_catalog_item_id: null, po_default_qty: null,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
})

const property = (over: Partial<Property> = {}) => ({
  id: 'prop-1', org_id: ORG, name: 'Lake House', ...over,
} as Property)

vi.mock('@/lib/dexie/dashboard/syncService', () => ({
  // Runs the caller's local write, then records the queued mutation — the same
  // contract as the real one, minus the drain kick.
  enqueueDashboardMutation: vi.fn(async (_u, _o, mutation, localWrite) => {
    if (localWrite) await localWrite()
    queued.push(mutation)
  }),
}))

let queued: { kind: string; targetId: string; payload: Record<string, unknown> }[] = []

async function seedCache(opts: { forms?: boolean; sections?: boolean; items?: boolean; properties?: boolean } = {}) {
  const db = getDashboardDb(USER, ORG)
  if (opts.forms      !== false) await db.inspection_forms.put(form())
  if (opts.sections   !== false) await db.inspection_form_sections.put(section())
  if (opts.items      !== false) await db.inspection_form_items.put(item())
  if (opts.properties !== false) await db.properties.put(property())
}

beforeEach(async () => {
  queued = []
  closeDashboardDb()
  const db = getDashboardDb(USER, ORG)
  await db.open()
  await Promise.all([
    db.inspections.clear(), db.inspection_forms.clear(),
    db.inspection_form_sections.clear(), db.inspection_form_items.clear(),
    db.properties.clear(),
  ])
})

describe('startInspectionLocally', () => {
  it('creates the inspection locally and queues it, with no network at all', async () => {
    await seedCache()
    const result = await startInspectionLocally(USER, ORG, { propertyId: 'prop-1', formKey: 'safety' })

    expect(result.ok).toBe(true)
    const id = (result as { inspectionId: string }).inspectionId

    const row = await getDashboardDb(USER, ORG).inspections.get(id)
    expect(row).toMatchObject({ org_id: ORG, property_id: 'prop-1', form_id: 'form-1', form_version: 1 })
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ kind: 'inspection.create', targetId: id })
  })

  it('the DEVICE builds the form snapshot, and it round-trips', async () => {
    // It must be the device's: the snapshot records the form actually WALKED,
    // and rebuilding it server-side at create would freeze whatever the form
    // says at sync time — a different set of questions after a re-seed.
    await seedCache()
    const result = await startInspectionLocally(USER, ORG, { propertyId: 'prop-1', formKey: 'safety' })
    const row = await getDashboardDb(USER, ORG).inspections.get((result as { inspectionId: string }).inspectionId)

    const snapshot = parseFormSnapshot(row!.form_snapshot)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.form_key).toBe('safety')
    expect(snapshot!.sections[0]!.items.map((i) => i.key)).toEqual(['fire.a'])
  })

  it('records the start as DEVICE-timed, with the raw claim kept', async () => {
    await seedCache()
    const result = await startInspectionLocally(USER, ORG, { propertyId: 'prop-1', formKey: 'safety' })
    const row = await getDashboardDb(USER, ORG).inspections.get((result as { inspectionId: string }).inspectionId)

    expect(row!.started_at_source).toBe('device')
    expect(row!.device_started_at).toBe(row!.started_at)
    // The server measures and fills this at create; the device cannot know it.
    expect(row!.device_clock_offset_seconds).toBeNull()
  })

  it('leaves the header snapshot to the server', async () => {
    // The letterhead needs the org owner's name, a role-filtered membership
    // read. Caching that on every tablet is a worse trade than accepting that
    // it reflects the moment the create lands.
    await seedCache()
    const result = await startInspectionLocally(USER, ORG, { propertyId: 'prop-1', formKey: 'safety' })
    const row = await getDashboardDb(USER, ORG).inspections.get((result as { inspectionId: string }).inspectionId)
    expect(row!.header_snapshot).toBeNull()
  })

  it('does NOT stamp device_now — the offset is only meaningful at POST', async () => {
    // Both clocks have to be read at the same instant. Stamped here it could be
    // hours stale by the time it syncs, corrupting the very correction it
    // exists to enable; the upload handler adds it at send time.
    await seedCache()
    await startInspectionLocally(USER, ORG, { propertyId: 'prop-1', formKey: 'safety' })
    expect(queued[0]!.payload).not.toHaveProperty('device_now')
    expect(queued[0]!.payload).toHaveProperty('device_started_at')
  })

  it('two starts never collide', async () => {
    await seedCache()
    const a = await startInspectionLocally(USER, ORG, { propertyId: 'prop-1', formKey: 'safety' })
    const b = await startInspectionLocally(USER, ORG, { propertyId: 'prop-1', formKey: 'safety' })
    expect((a as { inspectionId: string }).inspectionId)
      .not.toBe((b as { inspectionId: string }).inspectionId)
    expect(await getDashboardDb(USER, ORG).inspections.count()).toBe(2)
  })
})

describe('startInspectionLocally — a partial cache REFUSES', () => {
  const start = () => startInspectionLocally(USER, ORG, { propertyId: 'prop-1', formKey: 'safety' })

  it('no forms at all', async () => {
    await seedCache({ forms: false, sections: false, items: false })
    const result = await start()
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/forms aren’t on this device/)
    expect(queued).toHaveLength(0)
  })

  it('a form whose ITEMS did not download', async () => {
    // The dangerous one. A form with sections but no items would resolve to a
    // walk with no questions — which looks like a completed inspection.
    await seedCache({ items: false })
    expect((await start()).ok).toBe(false)
  })

  it('a form whose SECTIONS did not download', async () => {
    await seedCache({ sections: false })
    expect((await start()).ok).toBe(false)
  })

  it('an INACTIVE form is not startable', async () => {
    await getDashboardDb(USER, ORG).inspection_forms.clear()
    await getDashboardDb(USER, ORG).inspection_forms.put(form({ is_active: false }))
    await seedCache({ forms: false })
    expect((await start()).ok).toBe(false)
  })

  it('the property is not cached', async () => {
    await seedCache({ properties: false })
    const result = await start()
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/property isn’t on this device/)
  })

  it('a property belonging to ANOTHER org is refused', async () => {
    // The cache is keyed per (user, org), so this should be impossible — which
    // is exactly why it is checked rather than assumed.
    await seedCache({ properties: false })
    await getDashboardDb(USER, ORG).properties.put(property({ org_id: 'someone-else' }))
    expect((await start()).ok).toBe(false)
  })

  it('picks the HIGHEST active version when several are cached', async () => {
    await seedCache()
    const db = getDashboardDb(USER, ORG)
    await db.inspection_forms.put(form({ id: 'form-2', version: 2 }))
    await db.inspection_form_sections.put(section({ id: 'sec-2', form_id: 'form-2' }))
    await db.inspection_form_items.put(item({ id: 'item-2', section_id: 'sec-2', key: 'fire.b' }))

    const result = await startInspectionLocally(USER, ORG, { propertyId: 'prop-1', formKey: 'safety' })
    const row = await db.inspections.get((result as { inspectionId: string }).inspectionId)
    expect(row!.form_id).toBe('form-2')
    expect(row!.form_version).toBe(2)
  })
})
