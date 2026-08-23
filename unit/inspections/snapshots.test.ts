import { describe, expect, it } from 'vitest'

import {
  buildFormSnapshot,
  buildHeaderSnapshot,
  formFromSnapshot,
  parseFormSnapshot,
  recordedConditions,
  reportedConditions,
} from '@/lib/inspections/snapshots'
import { resolveFormPages } from '@/lib/inspections/resolve-form'
import type {
  InspectionFormItem,
  InspectionFormSection,
  Property,
} from '@/types/database'

// ============================================================================
// A snapshot is the difference between a report that says what it said and one
// that quietly re-renders itself.
//
// Both halves are frozen for the same reason and against different clocks. The
// FORM moves because the seed upserts by key on every merge that touches the
// definitions — a reworded item shipping in March would otherwise rewrite what
// January's report claims to have asked. The LETTERHEAD moves because every
// field on it is a live row: an ownership transfer would silently restate three
// years of past reports.
// ============================================================================

let seq = 0
const uid = () => `id-${++seq}`

function section(over: Partial<InspectionFormSection> = {}): InspectionFormSection {
  return {
    id: uid(), form_id: 'f1', key: 'sec', name: 'Section', sort_order: 0,
    shown_when_asset: null, created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function item(over: Partial<InspectionFormItem> & { section_id: string }): InspectionFormItem {
  return {
    id: uid(), key: `k-${seq}`, prompt: `Prompt ${seq}`, sort_order: 0,
    response_type: 'yes_no', is_required: true, photo_required: false,
    parent_item_id: null, show_when: null,
    repeat_source_item_id: null, repeat_per_asset: false,
    na_reason_template: null, na_asset_type: null, asset_type: null,
    concern_key: null, remediation: 'work_order', default_actions: ['repair'],
    wo_category: null, wo_priority: null,
    po_catalog_item_id: null, po_default_qty: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

const NOW = '2026-08-22T14:00:00Z'

describe('buildFormSnapshot', () => {
  it('records sections and items in the order the form is WALKED, not array order', () => {
    // The snapshot's job is to preserve the walk. Leaving order to the reader
    // would make a re-render depend on jsonb key order — which is to say, on
    // nothing dependable at all.
    const a = section({ key: 'second', sort_order: 2 })
    const b = section({ key: 'first',  sort_order: 1 })
    const snap = buildFormSnapshot('safety', 1, [a, b], [
      item({ section_id: b.id, key: 'b2', sort_order: 2 }),
      item({ section_id: b.id, key: 'b1', sort_order: 1 }),
      item({ section_id: a.id, key: 'a1', sort_order: 1 }),
    ], NOW)

    expect(snap.sections.map((s) => s.key)).toEqual(['first', 'second'])
    expect(snap.sections[0]!.items.map((i) => i.key)).toEqual(['b1', 'b2'])
  })

  it('carries the gate, so a re-render knows why a section was absent', () => {
    // Without it, a report of a municipal-water property is indistinguishable
    // from one where the well section was skipped.
    const well = section({ key: 'well', shown_when_asset: 'well_pump' })
    const snap = buildFormSnapshot('outdoor', 1, [well], [item({ section_id: well.id })], NOW)
    expect(snap.sections[0]!.shown_when_asset).toBe('well_pump')
  })

  it('stamps the form identity and the capture time', () => {
    const s = section()
    const snap = buildFormSnapshot('indoor', 3, [s], [item({ section_id: s.id })], NOW)
    expect(snap).toMatchObject({ form_key: 'indoor', form_version: 3, captured_at: NOW })
  })

  it('a section with no items is still recorded', () => {
    // The resolver drops an empty section from the PAGER; the snapshot is a
    // record of the definition, not of what one property saw. Conflating the
    // two would lose the fact that the section existed at all.
    const s = section({ key: 'assets' })
    const snap = buildFormSnapshot('indoor', 1, [s], [], NOW)
    expect(snap.sections).toHaveLength(1)
    expect(snap.sections[0]!.items).toEqual([])
  })
})

describe('buildHeaderSnapshot', () => {
  const property = {
    name: 'Lake House', address: '12 Oak St', city: 'Alexander City',
    state: 'AL', zip: '35010',
  } as Pick<Property, 'name' | 'address' | 'city' | 'state' | 'zip'>

  it('freezes the letterhead', () => {
    const snap = buildHeaderSnapshot({
      property, orgName: 'Lake Martin Delivery', orgOwnerName: 'S. Jones',
      conditions: null, capturedAt: NOW,
    })
    expect(snap).toEqual({
      property_name:    'Lake House',
      property_address: '12 Oak St, Alexander City, AL 35010',
      org_name:         'Lake Martin Delivery',
      org_owner_name:   'S. Jones',
      captured_at:      NOW,
      conditions:       null,
    })
  })

  it('drops empty address parts rather than printing their separators', () => {
    // "12 Oak St, , AL 35010" is a worse artifact than "12 Oak St, AL 35010",
    // and this is a document someone hands to an adjuster.
    const snap = buildHeaderSnapshot({
      property: { ...property, city: null, zip: '  ' },
      orgName: 'Org', orgOwnerName: null, conditions: null, capturedAt: NOW,
    })
    expect(snap.property_address).toBe('12 Oak St, AL')
  })

  it('survives a property with no address at all', () => {
    const snap = buildHeaderSnapshot({
      property: { name: 'X', address: null, city: null, state: null, zip: null },
      orgName: 'Org', orgOwnerName: null, conditions: null, capturedAt: NOW,
    })
    expect(snap.property_address).toBe('')
  })
})

describe('conditions — recorded and reported are never the same claim', () => {
  // §12.3: "Conditions: 41°F, light rain (recorded)" is a different claim from
  // "Conditions: overcast (reported)", and printing them identically would
  // quietly launder one into the other. They are separate SHAPES so the report
  // cannot conflate them even by accident.
  it('a machine reading is tagged recorded and keeps its measurements', () => {
    expect(recordedConditions({
      temperature: 41, weatherLabel: 'Light Rain', isRainy: true, isSnowy: false,
    })).toEqual({
      source: 'recorded', temperature_f: 41, label: 'Light Rain',
      is_rainy: true, is_snowy: false,
    })
  })

  it('no weather is null, not an empty recording', () => {
    // §12.3: offline the lookup will not resolve at all, "which is precisely
    // when an outdoor inspection is most likely to be happening". Null is an
    // expected outcome, and a `recorded` entry with blank values would be a
    // machine claim nobody made.
    expect(recordedConditions(null)).toBeNull()
  })

  it('a typed reading is tagged reported', () => {
    expect(reportedConditions('overcast, dry')).toEqual({ source: 'reported', text: 'overcast, dry' })
  })

  it('whitespace is not a reading', () => {
    expect(reportedConditions('   ')).toBeNull()
    expect(reportedConditions('')).toBeNull()
  })

  it('the two shapes are distinguishable without inspecting content', () => {
    const rec = recordedConditions({ temperature: 60, weatherLabel: 'Clear', isRainy: false, isSnowy: false })
    const rep = reportedConditions('clear')
    expect(rec?.source).toBe('recorded')
    expect(rep?.source).toBe('reported')
    // …and a reported reading carries NO measurements to mistake for real ones.
    expect(rep && 'temperature_f' in rep).toBe(false)
  })
})

// ============================================================================
// READING THE SNAPSHOT BACK.
//
// This is the fill screen's ONLY source for the form — not a join to
// inspection_form_items. Three things follow, and all three are the point: it
// works with no connection, a re-seed mid-walk cannot change the questions
// under the inspector, and a historical report re-renders through the exact
// same code path as a live one.
//
// It reads out of jsonb, so nothing about the shape can be assumed. The failure
// worth guarding is not a throw — it is a MALFORMED snapshot resolving to a
// SHORTER form, which renders as a perfectly normal inspection with questions
// missing.
// ============================================================================

describe('parseFormSnapshot', () => {
  const s = section({ key: 'fire', name: 'Fire', sort_order: 1 })
  const good = buildFormSnapshot('safety', 2, [s], [item({ section_id: s.id, key: 'fire.a' })], NOW)

  it('round-trips what buildFormSnapshot wrote, through JSON', () => {
    // Through JSON deliberately: the value really does go to Postgres as jsonb
    // and come back parsed, so a type that only survives in-process proves
    // nothing.
    expect(parseFormSnapshot(JSON.parse(JSON.stringify(good)))).toEqual(good)
  })

  it('rejects anything that is not a snapshot, rather than half-reading it', () => {
    for (const bad of [null, undefined, 'safety', 42, [], {}, { form_key: 'safety' }]) {
      expect(parseFormSnapshot(bad), JSON.stringify(bad) ?? 'undefined').toBeNull()
    }
  })

  it('rejects a snapshot whose sections are malformed — it does NOT drop them', () => {
    // The dangerous outcome. Skipping a bad section would produce a shorter
    // form that looks complete: the inspector answers every question shown,
    // the gate passes, and the report is silently missing a whole section.
    expect(parseFormSnapshot({ ...good, sections: [{ id: 'x', key: 'k' }] })).toBeNull()
    expect(parseFormSnapshot({ ...good, sections: [{ ...good.sections[0], items: 'nope' }] })).toBeNull()
    expect(parseFormSnapshot({ ...good, sections: 'nope' })).toBeNull()
  })

  it('a missing gate reads as ungated, never as a truthy string', () => {
    const noGate = parseFormSnapshot({
      ...good,
      sections: [{ ...good.sections[0], shown_when_asset: undefined }],
    })
    expect(noGate!.sections[0]!.shown_when_asset).toBeNull()
  })
})

describe('formFromSnapshot', () => {
  it('flattens back into what the resolver takes, and resolves identically', () => {
    // The contract that matters: a form resolved from the LIVE rows and the
    // same form resolved from its snapshot must produce the same pages, or a
    // historical report is not a re-render of what was asked.
    const a = section({ key: 'one', sort_order: 1 })
    const b = section({ key: 'two', sort_order: 2, shown_when_asset: 'well_pump' })
    const items = [
      item({ section_id: a.id, key: 'a1', sort_order: 1 }),
      item({ section_id: b.id, key: 'b1', sort_order: 1 }),
    ]

    const live = resolveFormPages({ sections: [a, b], items, assets: [] })
    const snap = formFromSnapshot(buildFormSnapshot('safety', 1, [a, b], items, NOW))
    const fromSnapshot = resolveFormPages({ ...snap, assets: [] })

    expect(fromSnapshot.map((p) => p.sectionKey)).toEqual(live.map((p) => p.sectionKey))
    expect(fromSnapshot).toEqual(live)
  })

  it('carries the gate through, so a re-render still skips what was skipped', () => {
    const well = section({ key: 'well', shown_when_asset: 'well_pump' })
    const snap = formFromSnapshot(
      buildFormSnapshot('outdoor', 1, [well], [item({ section_id: well.id })], NOW),
    )
    expect(resolveFormPages({ ...snap, assets: [] })).toEqual([])
  })
})
