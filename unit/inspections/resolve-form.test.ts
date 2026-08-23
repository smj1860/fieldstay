import { describe, expect, it } from 'vitest'

import {
  answerKey,
  findOutstanding,
  MAX_REPEAT_INSTANCES,
  pageProgress,
  resolveFormPages,
  visibleNodes,
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
      [keyFor('fire.b')]: { result: 'pass', photoPath: 'o/i/b.jpg' },
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.reason).toBe('fail_needs_description')
  })

  it('a fail missing BOTH reports the description first — it has to be typed, not tapped', () => {
    const out = run({
      [keyFor('fire.a')]: { result: 'pass' },
      [keyFor('fire.b')]: { result: 'fail' },
    })
    expect(out.map((o) => o.reason)).toEqual(['fail_needs_description'])
  })

  it('a PASSING photo_required item still owes its photo', () => {
    // The bug this covers: the photo check used to sit behind
    // `if (result !== 'fail') return null`, so it never ran on a pass. Every
    // photo_required item in all three forms is one §12.1 wants photographed
    // EVERY time — the extinguisher tag above all, where "the tag IS the record
    // and a claim about it is worth less than the picture". The rule was
    // unreachable in production and no test noticed, because the only fixture
    // that exercised it answered `fail`.
    expect(run({
      [keyFor('fire.a')]: { result: 'pass' },
      [keyFor('fire.b')]: { result: 'pass' },
    }).map((o) => [o.itemKey, o.reason])).toEqual([['fire.b', 'needs_photo']])

    expect(run({
      [keyFor('fire.a')]: { result: 'pass' },
      [keyFor('fire.b')]: { result: 'pass', photoPath: 'o/i/b.jpg' },
    })).toEqual([])
  })

  it('N/A is exempt from the photo requirement', () => {
    // An item that does not apply has nothing to photograph. Demanding a
    // picture of an absent pool gate is a gate nobody can pass.
    expect(run({
      [keyFor('fire.a')]: { result: 'pass' },
      [keyFor('fire.b')]: { result: 'na' },
    })).toEqual([])
  })

  it('a fail on a photo_required item needs a photo OR an honest reason', () => {
    const base = { [keyFor('fire.a')]: { result: 'pass' as const } }

    expect(run({ ...base, [keyFor('fire.b')]: { result: 'fail', note: 'back door jammed' } })
      .map((o) => o.reason)).toEqual(['needs_photo'])

    expect(run({ ...base, [keyFor('fire.b')]: { result: 'fail', note: 'back door jammed', photoPath: 'o/i/x.jpg' } }))
      .toEqual([])

    // The escape hatch is a REASON, never a silent skip: an unenforceable rule
    // produces a photograph of the floor, which is worse evidence than an
    // honest "camera failed".
    expect(run({ ...base, [keyFor('fire.b')]: { result: 'fail', note: 'jammed', photoUnavailableReason: 'camera failed' } }))
      .toEqual([])
    // …and whitespace is not a reason.
    expect(run({ ...base, [keyFor('fire.b')]: { result: 'fail', note: 'jammed', photoUnavailableReason: '   ' } })
      .map((o) => o.reason)).toEqual(['needs_photo'])
  })

  it('a complete form is empty — the gate can actually be passed', () => {
    // Paired with the tests above on purpose: "everything is outstanding" would
    // satisfy all of them and make sign-off unreachable.
    expect(run({
      [keyFor('fire.a')]: { result: 'pass' },
      [keyFor('fire.b')]: { result: 'na' },
    })).toEqual([])
  })

  describe('a conditional child counts exactly when its condition is met', () => {
    // The original implementation hardcoded `show_when !== 'fail'` and skipped
    // everything else, assuming every child was a "→ which room failed?"
    // follow-up. Outdoor's HOA question broke that assumption: its three items
    // are `show_when: 'pass'` children of "Property is subject to an HOA", so on
    // a property that IS in an HOA they rendered, were required, and could never
    // be reported — the Review gate would pass with all three blank.
    //
    // 24 tests did not discriminate on this, because the only conditional-child
    // case covered was one that should NOT be reported. These four are the
    // matrix: both polarities, both met and unmet.
    const build = (showWhen: 'pass' | 'fail') => {
      const sec = section({ key: 'x' })
      const parent = item({ section_id: sec.id, key: 'x.parent' })
      const child  = item({ section_id: sec.id, key: 'x.child', parent_item_id: parent.id, show_when: showWhen })
      const pages  = resolveFormPages({ sections: [sec], items: [parent, child], assets: [] })
      return {
        pages,
        parentKey: answerKey(pages[0]!.items[0]!),
        reported:  (answers: Record<string, AnswerState>) =>
          findOutstanding(pages, answers).map((o) => o.itemKey),
      }
    }

    it('show_when pass — reported once the parent passes', () => {
      const { parentKey, reported } = build('pass')
      expect(reported({ [parentKey]: { result: 'pass' } })).toContain('x.child')
    })

    it('show_when pass — NOT reported when the parent fails or is unanswered', () => {
      const { parentKey, reported } = build('pass')
      expect(reported({ [parentKey]: { result: 'fail', note: 'x' } })).not.toContain('x.child')
      expect(reported({})).not.toContain('x.child')
    })

    it('show_when fail — reported once the parent fails', () => {
      const { parentKey, reported } = build('fail')
      expect(reported({ [parentKey]: { result: 'fail', note: 'x' } })).toContain('x.child')
    })

    it('show_when fail — NOT reported when the parent passes', () => {
      const { parentKey, reported } = build('fail')
      expect(reported({ [parentKey]: { result: 'pass' } })).not.toContain('x.child')
    })
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

// ============================================================================
// FOUR OF THE FIVE RESPONSE TYPES DO NOT ANSWER WITH A PASS/FAIL.
//
// §5 gives inspection_form_items five response types and gives the answer row
// one `result pass|fail|na`. The gate used to treat a missing `result` as
// unanswered for ALL of them, which made it demand a verdict on "Number of fire
// extinguishers" — a question with no verdict to give, and therefore a Review
// page no inspector could ever clear. Three seeded items are `count`, one is
// `date`, nine are `text`, and every one of them is required.
// ============================================================================

describe('findOutstanding — an answer is whatever the response type actually asks for', () => {
  const s = section({ key: 'fire', name: 'Fire Safety' })

  const oneItem = (over: Partial<InspectionFormItem>) => {
    const it = item({ section_id: s.id, key: 'x', ...over })
    const pages = resolveFormPages({ sections: [s], items: [it], assets: [] })
    return {
      key: answerKey(pages[0]!.items[0]!),
      run: (answers: Record<string, AnswerState>) => findOutstanding(pages, answers),
    }
  }

  it('a count is answered by a NUMBER, and zero is a real answer', () => {
    const { key, run } = oneItem({ response_type: 'count' })
    expect(run({}).map((o) => o.reason)).toEqual(['unanswered'])
    // Zero extinguishers is a finding, not a blank. `?? ` and truthiness both
    // get this wrong, which is why the check is an explicit null/undefined one.
    expect(run({ [key]: { valueNumber: 0 } })).toEqual([])
    expect(run({ [key]: { valueNumber: 3 } })).toEqual([])
    // …and a pass/fail is NOT an answer to "how many".
    expect(run({ [key]: { result: 'pass' } }).map((o) => o.reason)).toEqual(['unanswered'])
  })

  it('a text item is answered by text, not by the failure description', () => {
    const { key, run } = oneItem({ response_type: 'text' })
    expect(run({ [key]: { valueText: 'Kitchen, under sink' } })).toEqual([])
    // `note` is the WO title on a fail; it is not this item's answer.
    expect(run({ [key]: { note: 'Kitchen, under sink' } }).map((o) => o.reason)).toEqual(['unanswered'])
    expect(run({ [key]: { valueText: '   ' } }).map((o) => o.reason)).toEqual(['unanswered'])
  })

  it('a date item is answered by a date', () => {
    const { key, run } = oneItem({ response_type: 'date' })
    expect(run({ [key]: { valueDate: '2028-04-01' } })).toEqual([])
    expect(run({}).map((o) => o.reason)).toEqual(['unanswered'])
  })

  it('a photo item is answered by the photo, and reports as needing one', () => {
    const { key, run } = oneItem({ response_type: 'photo', photo_required: true })
    // Not 'unanswered' — "Tag photo: not answered" tells the inspector less
    // than "Tag photo: no photo", and they are one tap apart on screen.
    expect(run({}).map((o) => o.reason)).toEqual(['needs_photo'])
    expect(run({ [key]: { photoPath: 'o/i/tag.jpg' } })).toEqual([])
    expect(run({ [key]: { photoUnavailableReason: 'tag illegible' } })).toEqual([])
  })

  it('an OPTIONAL item of any type is never outstanding for being blank', () => {
    const { run } = oneItem({ response_type: 'text', is_required: false })
    expect(run({})).toEqual([])
  })
})

describe('a count sizes its repeat group, so it is clamped', () => {
  const build = (count: number) => {
    const s = section({ key: 'fire' })
    const counter = item({ section_id: s.id, key: 'fire.count', response_type: 'count' })
    const member  = item({ section_id: s.id, key: 'fire.loc', repeat_source_item_id: counter.id })
    const pages = resolveFormPages({
      sections: [s], items: [counter, member], assets: [],
      countsByItemId: { [counter.id]: count },
    })
    return pages[0]!.items.filter((i) => i.repeatIndex !== undefined).length
  }

  it('renders one group per unit counted', () => {
    expect(build(3)).toBe(3)
    expect(build(0)).toBe(0)
  })

  it('a fat-fingered count cannot render an unbounded page', () => {
    // The failure this prevents is not cosmetic: a mistyped 100000 renders that
    // many rows and freezes the tablet in the middle of an inspection, which is
    // the one moment there is no way to recover. Matched by the
    // inspection_items_value_number_range CHECK for writes that skip this path.
    expect(build(100_000)).toBe(MAX_REPEAT_INSTANCES)
  })

  it('a negative or fractional count is not a row count', () => {
    expect(build(-5)).toBe(0)
    expect(build(2.7)).toBe(2)
  })
})

describe('visibleNodes — the renderer and the gate share ONE definition', () => {
  const s = section({ key: 'hoa', name: 'HOA' })
  const parent = item({ section_id: s.id, key: 'hoa.subject' })
  const onPass = item({ section_id: s.id, key: 'hoa.dues', parent_item_id: parent.id, show_when: 'pass' })
  const onFail = item({ section_id: s.id, key: 'hoa.why',  parent_item_id: parent.id, show_when: 'fail', sort_order: 1 })
  const pages = resolveFormPages({ sections: [s], items: [parent, onPass, onFail], assets: [] })
  const pKey = answerKey(pages[0]!.items[0]!)

  const keysWhen = (answers: Record<string, AnswerState>) =>
    visibleNodes(pages[0]!, answers).map((n) => n.item.formItem.key)

  it('shows only the branch the parent actually took', () => {
    expect(keysWhen({})).toEqual(['hoa.subject'])
    expect(keysWhen({ [pKey]: { result: 'pass' } })).toEqual(['hoa.subject', 'hoa.dues'])
    expect(keysWhen({ [pKey]: { result: 'fail' } })).toEqual(['hoa.subject', 'hoa.why'])
  })

  it('marks a follow-up as nested so the renderer can indent it', () => {
    expect(visibleNodes(pages[0]!, { [pKey]: { result: 'pass' } }).map((n) => n.depth))
      .toEqual([0, 1])
  })

  it('progress counts what is ON SCREEN, never a hidden branch', () => {
    // Counting hidden children would leave a page permanently short of
    // complete, which reads as "you missed something" for a question the
    // inspector was never shown.
    expect(pageProgress(pages[0]!, {})).toEqual({ answered: 0, total: 1 })
    expect(pageProgress(pages[0]!, { [pKey]: { result: 'pass' } })).toEqual({ answered: 1, total: 2 })
    expect(pageProgress(pages[0]!, {
      [pKey]: { result: 'pass' },
      [answerKey(pages[0]!.items[0]!.children.find((c) => c.formItem.key === 'hoa.dues')!)]: { result: 'pass' },
    })).toEqual({ answered: 2, total: 2 })
  })

  it('the gate sees exactly what visibleNodes shows — not a second rule', () => {
    // These two agreeing is the whole point. They disagreed once: the gate
    // hardcoded `show_when !== 'fail'`, so the `show_when: 'pass'` HOA items
    // rendered, were required, and could never be reported.
    for (const answers of [{}, { [pKey]: { result: 'pass' as const } }, { [pKey]: { result: 'fail' as const } }]) {
      const visible    = new Set(keysWhen(answers))
      const complained = new Set(findOutstanding(pages, answers).map((o) => o.itemKey))
      for (const key of complained) expect(visible.has(key), `${key} reported but not shown`).toBe(true)
    }
  })
})
