import { describe, expect, it } from 'vitest'

import {
  answerKey,
  findOutstanding,
  resolveFormPages,
  type AnswerState,
} from '@/lib/inspections/resolve-form'
import type {
  InspectionFormItem,
  InspectionFormSection,
  PropertyAsset,
} from '@/types/database'

// ============================================================================
// What a form ASKS is the same for every tenant. What one PROPERTY is asked is
// not, and every difference here is structural — it changes the page count and
// the row count, which is what the pager is built on.
//
// The §12.3 gates are the sharp ones. A municipal-water property must never see
// the well section, and the reason is not tidiness: the spec is explicit that
// the skip has to be LEDGER-BACKED rather than inspector-asserted, because the
// person who benefits from skipping the well questions is the one who would
// otherwise be asserting there is no well.
// ============================================================================

let seq = 0
const uid = () => `id-${++seq}`

function section(over: Partial<InspectionFormSection> = {}): InspectionFormSection {
  return {
    id: uid(), form_id: 'form-1', key: 'sec', name: 'Section', sort_order: 0,
    shown_when_asset: null,
    created_at: '2026-01-01T00:00:00Z',
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

function asset(over: Partial<PropertyAsset> = {}): PropertyAsset {
  return {
    id: uid(), org_id: 'o1', property_id: 'p1', name: 'Asset',
    asset_type: 'hvac', make: null, model: null, serial_number: null,
    installation_date: null, manufacture_date: null, purchase_price: null,
    estimated_replacement_cost: null, expected_lifespan_years: null,
    warranty_expiry_date: null, warranty_provider: null, warranty_notes: null,
    placed_in_service_date: null, macrs_class: null, depreciation_method: null,
    salvage_value: null, health_score: null, health_score_updated_at: null,
    replacement_status: 'projected', is_active: true, replaced_by_asset_id: null,
    ...over,
  } as PropertyAsset
}

describe('resolveFormPages — conditional sections', () => {
  it('hides an asset-gated section when the property has no such asset', () => {
    const normal = section({ key: 'grounds', sort_order: 0 })
    const well   = section({ key: 'well', sort_order: 1, shown_when_asset: 'well_pump' })

    const pages = resolveFormPages({
      sections: [normal, well],
      items: [item({ section_id: normal.id }), item({ section_id: well.id })],
      assets: [asset({ asset_type: 'hvac' })],
    })

    expect(pages.map((p) => p.sectionKey)).toEqual(['grounds'])
  })

  it('shows it when the property does have one', () => {
    const well = section({ key: 'well', shown_when_asset: 'well_pump' })
    const pages = resolveFormPages({
      sections: [well],
      items: [item({ section_id: well.id })],
      assets: [asset({ asset_type: 'well_pump' })],
    })
    expect(pages.map((p) => p.sectionKey)).toEqual(['well'])
  })

  it('an INACTIVE asset does not open the gate', () => {
    // A replaced well pump must not resurrect nine well questions. `is_active`
    // is filtered here rather than trusted of the caller.
    const well = section({ key: 'well', shown_when_asset: 'well_pump' })
    const pages = resolveFormPages({
      sections: [well],
      items: [item({ section_id: well.id })],
      assets: [asset({ asset_type: 'well_pump', is_active: false })],
    })
    expect(pages).toEqual([])
  })

  it('there is no property-field gate left to honour', () => {
    // The HOA section used to be gated on `properties.hoa_name`. That column is
    // gone (20260822230000): FieldStay never held the fact and will not collect
    // it, and a gate on a column nothing populates does not fail safe — it
    // silently deletes three real questions while reading as a condition.
    const hoa = section({ key: 'hoa' })
    const pages = resolveFormPages({
      sections: [hoa], items: [item({ section_id: hoa.id })], assets: [],
    })
    expect(pages.map((p) => p.sectionKey)).toEqual(['hoa'])
  })

  it('an ungated section always renders', () => {
    const s = section({ key: 'fire' })
    const pages = resolveFormPages({
      sections: [s], items: [item({ section_id: s.id })], assets: [],
    })
    expect(pages.length).toBe(1)
  })
})

describe('resolveFormPages — per-asset items', () => {
  it('renders one row per active asset, and none for a property with no assets', () => {
    const s = section({ key: 'assets' })
    const generic = item({ section_id: s.id, repeat_per_asset: true, key: 'assets.condition' })

    const three = resolveFormPages({
      sections: [s], items: [generic],
      assets: [
        asset({ asset_type: 'generator' }),
        asset({ asset_type: 'solar_system' }),
        asset({ asset_type: 'septic_system' }),
      ],
    })
    expect(three[0]!.items).toHaveLength(3)
    expect(three[0]!.items.map((i) => i.asset?.asset_type))
      .toEqual(['generator', 'solar_system', 'septic_system'])

    // No assets → the section resolves to nothing and is not a page at all,
    // rather than an empty page with a Next button and no explanation.
    expect(resolveFormPages({
      sections: [s], items: [generic], assets: [],
    })).toEqual([])
  })

  it('skips asset types a NAMED item already asks about', () => {
    // §12.2 §7: "every ACTIVE property_assets row whose asset_type is not
    // already covered above". The HVAC unit has its own question earlier, so
    // the generic sweep asking "operational?" about it again would be a second
    // row for the inspector to disagree with themselves on.
    const named   = section({ key: 'utility',  sort_order: 0 })
    const sweep   = section({ key: 'assets',   sort_order: 1 })
    const items = [
      item({ section_id: named.id, asset_type: 'hvac', key: 'utility.hvac' }),
      item({ section_id: sweep.id, repeat_per_asset: true, key: 'assets.condition' }),
    ]

    const pages = resolveFormPages({
      sections: [named, sweep], items,
      assets: [asset({ asset_type: 'hvac' }), asset({ asset_type: 'generator' })],
    })

    const sweepPage = pages.find((p) => p.sectionKey === 'assets')!
    expect(sweepPage.items.map((i) => i.asset?.asset_type)).toEqual(['generator'])
  })

  it('an inactive asset gets no row', () => {
    const s = section({ key: 'assets' })
    const pages = resolveFormPages({
      sections: [s],
      items: [item({ section_id: s.id, repeat_per_asset: true })],
      assets: [asset({ asset_type: 'generator', is_active: false }), asset({ asset_type: 'roof' })],
    })
    expect(pages[0]!.items.map((i) => i.asset?.asset_type)).toEqual(['roof'])
  })
})

describe('resolveFormPages — repeat groups', () => {
  const build = (count?: number) => {
    const s = section({ key: 'fire' })
    const source = item({ section_id: s.id, key: 'fire.count', response_type: 'count', sort_order: 0 })
    const loc  = item({ section_id: s.id, key: 'fire.loc',   repeat_source_item_id: source.id, sort_order: 0 })
    const chg  = item({ section_id: s.id, key: 'fire.charged', repeat_source_item_id: source.id, sort_order: 1 })
    return resolveFormPages({
      sections: [s], items: [source, loc, chg], assets: [],
      ...(count !== undefined && { countsByItemId: { [source.id]: count } }),
    })
  }

  it('produces nothing before the count is answered', () => {
    expect(build().at(0)!.items.map((i) => i.formItem.key)).toEqual(['fire.count'])
    expect(build(0).at(0)!.items.map((i) => i.formItem.key)).toEqual(['fire.count'])
  })

  it('groups PER INSTANCE, not per member', () => {
    // The inspector works through one extinguisher's location and charge
    // together, not every location followed by every charge.
    const items = build(3).at(0)!.items
    expect(items.map((i) => `${i.formItem.key}#${i.repeatIndex ?? '-'}`)).toEqual([
      'fire.count#-',
      'fire.loc#1', 'fire.charged#1',
      'fire.loc#2', 'fire.charged#2',
      'fire.loc#3', 'fire.charged#3',
    ])
  })

  it('a negative count cannot produce rows', () => {
    expect(build(-2).at(0)!.items).toHaveLength(1)
  })
})

describe('resolveFormPages — structure', () => {
  it('orders sections and items by sort_order, not by array position', () => {
    const a = section({ key: 'second', sort_order: 2 })
    const b = section({ key: 'first',  sort_order: 1 })
    const pages = resolveFormPages({
      sections: [a, b],
      items: [
        item({ section_id: b.id, key: 'b2', sort_order: 2 }),
        item({ section_id: b.id, key: 'b1', sort_order: 1 }),
        item({ section_id: a.id, key: 'a1', sort_order: 1 }),
      ],
      assets: [],
    })
    expect(pages.map((p) => p.sectionKey)).toEqual(['first', 'second'])
    expect(pages[0]!.items.map((i) => i.formItem.key)).toEqual(['b1', 'b2'])
  })

  it('attaches children WITHOUT resolving show_when', () => {
    // Deliberate: the renderer holds the parent's current answer, so resolving
    // visibility here would split one decision across two modules.
    const s = section({ key: 'fire' })
    const parent = item({ section_id: s.id, key: 'fire.smoke' })
    const child  = item({ section_id: s.id, key: 'fire.smoke_where', parent_item_id: parent.id, show_when: 'fail' })

    const page = resolveFormPages({
      sections: [s], items: [parent, child], assets: [],
    })[0]!

    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.children.map((c) => c.formItem.key)).toEqual(['fire.smoke_where'])
    expect(page.items[0]!.children[0]!.formItem.show_when).toBe('fail')
  })

  it('answerKey distinguishes repeat instances and per-asset rows', () => {
    // Without this, two extinguishers or two HVAC units would share one answer
    // and the second would silently overwrite the first.
    const s = section({ key: 'assets' })
    const generic = item({ section_id: s.id, repeat_per_asset: true })
    const page = resolveFormPages({
      sections: [s], items: [generic],
      assets: [asset({ asset_type: 'generator' }), asset({ asset_type: 'roof' })],
    })[0]!

    const [one, two] = page.items
    expect(answerKey(one!)).not.toBe(answerKey(two!))
  })
})

describe('findOutstanding — what the Review page lists', () => {
  const s = section({ key: 'fire', name: 'Fire Safety' })
  const required = item({ section_id: s.id, key: 'fire.a', prompt: 'Detectors present' })
  const photoOnFail = item({ section_id: s.id, key: 'fire.b', prompt: 'Exits clear', photo_required: true, sort_order: 1 })
  const pages = resolveFormPages({
    sections: [s], items: [required, photoOnFail], assets: [],
  })

  const run = (answers: Record<string, AnswerState>) => findOutstanding(pages, answers)
  const keyFor = (k: string) =>
    answerKey(pages[0]!.items.find((i) => i.formItem.key === k)!)

  it('lists a required item with no answer', () => {
    const out = run({})
    expect(out.map((o) => [o.itemKey, o.reason])).toEqual([
      ['fire.a', 'unanswered'],
      ['fire.b', 'unanswered'],
    ])
    expect(out[0]!.sectionName).toBe('Fire Safety')
    expect(out[0]!.pageIndex).toBe(0)
  })

  it('a fail with no description is outstanding — the description IS the work order title', () => {
    const out = run({
      [keyFor('fire.a')]: { result: 'fail' },
      [keyFor('fire.b')]: { result: 'pass' },
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.reason).toBe('fail_needs_description')
  })

  it('a fail on a photo_required item needs a photo OR an honest reason', () => {
    const base = { [keyFor('fire.a')]: { result: 'pass' as const } }

    expect(run({ ...base, [keyFor('fire.b')]: { result: 'fail', note: 'back door jammed' } })
      .map((o) => o.reason)).toEqual(['fail_needs_photo'])

    expect(run({ ...base, [keyFor('fire.b')]: { result: 'fail', note: 'back door jammed', photoPath: 'o/i/x.jpg' } }))
      .toEqual([])

    // The escape hatch is a REASON, never a silent skip: an unenforceable rule
    // produces a photograph of the floor, which is worse evidence than an
    // honest "camera failed".
    expect(run({ ...base, [keyFor('fire.b')]: { result: 'fail', note: 'jammed', photoUnavailableReason: 'camera failed' } }))
      .toEqual([])
    // …and whitespace is not a reason.
    expect(run({ ...base, [keyFor('fire.b')]: { result: 'fail', note: 'jammed', photoUnavailableReason: '   ' } })
      .map((o) => o.reason)).toEqual(['fail_needs_photo'])
  })

  it('a complete form is empty — the gate can actually be passed', () => {
    // Paired with the tests above on purpose: "everything is outstanding" would
    // satisfy all of them and make sign-off unreachable.
    expect(run({
      [keyFor('fire.a')]: { result: 'pass' },
      [keyFor('fire.b')]: { result: 'na' },
    })).toEqual([])
  })

  it('an unshown conditional child is not reported as missing', () => {
    const sec = section({ key: 'x' })
    const parent = item({ section_id: sec.id, key: 'x.p' })
    const child  = item({ section_id: sec.id, key: 'x.c', parent_item_id: parent.id, show_when: 'na' })
    const p = resolveFormPages({ sections: [sec], items: [parent, child], assets: [] })

    const out = findOutstanding(p, { [answerKey(p[0]!.items[0]!)]: { result: 'pass' } })
    expect(out.map((o) => o.itemKey)).toEqual([])
  })
})
