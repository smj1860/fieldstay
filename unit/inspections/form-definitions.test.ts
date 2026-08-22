import { describe, expect, it } from 'vitest'

import {
  CONCERN_KEY_MAP,
  EXPECTED_ROOT_ITEM_COUNTS,
  INSPECTION_FORMS,
  allItems,
  concernKeysInUse,
  rootItems,
  walkItems,
  type ItemDefinition,
} from '@/lib/inspections/forms'

// ============================================================================
// THE FORM DEFINITIONS ARE DATA, AND THIS IS THE ONLY THING THAT REVIEWS THEM.
//
// docs/INSPECTIONS_SPEC.md §10 asks for a seed test, and §12.3 says what it is
// for in one sentence worth repeating: "an item whose prompt matches another
// form's without a shared key is a review failure, and so is a shared key
// across two prompts that are not the same concern. The first produces
// duplicate work orders; the second silently merges two real ones, which is
// worse."
//
// That asymmetry drives everything below. A missed merge is visible — two work
// orders arrive and someone closes one. A wrong merge is not: the second fault
// is folded into the first dispatch and never seen again. So the checks on
// `concern_key` are deliberately stricter than the checks on anything else, and
// the map requires a written justification per key rather than inferring intent
// from the fact that two items happen to share a string.
// ============================================================================

const FORMS_BY_KEY = Object.fromEntries(INSPECTION_FORMS.map((f) => [f.key, f]))

/**
 * The ONLY item on any form whose failing answer is `yes`.
 *
 * §12.1: a trampoline is frequently a policy EXCLUSION rather than a hazard
 * rating, so the answer changes coverage regardless of the equipment's
 * condition and what matters is that the record states it plainly. Outdoor 39
 * separately asks whether it is sound. Registered here rather than exempted by
 * a pattern, so adding a second one is a decision somebody makes on purpose.
 */
const INVERTED_POLARITY_ITEMS = new Set(['safety.exterior_amenity.high_risk_equipment_present'])

/**
 * Sign-off sections are exempt from the "a No is the failure" rule wholesale.
 * "Does additional cleaning need to be scheduled?" is a scheduling question,
 * not a condition one — yes means more work, and it produces the cleaning
 * roll-up rather than a per-item record. Certification and signature are
 * attestations. None of the three is an observation that can fail.
 */
const SIGNOFF_SECTION_KEY = 'signoff'

describe('inspection form definitions', () => {
  it('every form is present with the item count the spec commits to', () => {
    expect(INSPECTION_FORMS.map((f) => f.key)).toEqual(['safety', 'indoor', 'outdoor'])

    for (const form of INSPECTION_FORMS) {
      expect(rootItems(form).length, `${form.key} top-level item count`)
        .toBe(EXPECTED_ROOT_ITEM_COUNTS[form.key])
    }
  })

  it('item keys are globally unique and namespaced to their form and section', () => {
    // Globally unique is STRICTER than the DB's (section_id, key). Deliberate:
    // the key appears in work orders, reports and the concern map, and a
    // copy-paste between two forms that resolved to two different rows with the
    // same name would be indistinguishable from a correct cross-form pair.
    const seen = new Map<string, string>()
    for (const form of INSPECTION_FORMS) {
      for (const section of form.sections) {
        for (const item of walkItems(section.items)) {
          const prior = seen.get(item.key)
          expect(prior, `duplicate item key ${item.key} (also in ${prior})`).toBeUndefined()
          seen.set(item.key, `${form.key}.${section.key}`)

          expect(item.key, `${item.key} must be namespaced <form>.<section>.<leaf>`)
            .toMatch(new RegExp(`^${form.key}\\.${section.key}\\.[a-z0-9_]+$`))
        }
      }
    }
  })

  it('section keys are unique within their form', () => {
    for (const form of INSPECTION_FORMS) {
      const keys = form.sections.map((s) => s.key)
      expect(new Set(keys).size, `${form.key} has duplicate section keys`).toBe(keys.length)
    }
  })

  it('every item carries a remediation decision coherent with its actions', () => {
    // `remediation` and `default_actions` are both REQUIRED by the TypeScript
    // type, so "the author forgot" cannot reach this test. What it checks is
    // the pairing, which the type cannot express — and which the DB enforces
    // too, via inspection_form_items_actions_match_remediation.
    for (const form of INSPECTION_FORMS) {
      for (const item of allItems(form)) {
        const where = `${item.key} (remediation=${item.remediation})`

        if (item.remediation === 'none' || item.remediation === 'notify') {
          expect(item.default_actions, `${where} must pre-tick nothing — it never dispatches`)
            .toEqual([])
          expect(item.wo_category, `${where} must not carry a wo_category`).toBeUndefined()
          continue
        }

        expect(item.default_actions.length, `${where} must pre-tick at least one action`)
          .toBeGreaterThan(0)

        // repair/service produce a work order; replace produces a purchase
        // order. The default must generate the kind of record the item claims.
        const producesPo = item.default_actions.includes('replace')
        const producesWo = item.default_actions.some((a) => a === 'repair' || a === 'service')

        if (item.remediation === 'work_order') {
          expect(producesWo, `${where} pre-ticks ${item.default_actions.join('+')}, which makes no work order`).toBe(true)
          expect(item.wo_category, `${where} creates a work order and needs a routing category`).toBeDefined()
        }
        if (item.remediation === 'purchase_order') {
          expect(producesPo, `${where} pre-ticks ${item.default_actions.join('+')}, which makes no purchase order`).toBe(true)
        }
      }
    }
  })

  it('no duplicate actions inside one default set', () => {
    for (const form of INSPECTION_FORMS) {
      for (const item of allItems(form)) {
        expect(new Set(item.default_actions).size, `${item.key} repeats an action`)
          .toBe(item.default_actions.length)
      }
    }
  })

  it('every observation item is phrased so that NO is the failure', () => {
    // The rule that makes a form readable as evidence: a reader scanning a
    // completed report sees the failures without having to re-derive each
    // item's polarity. The two exemptions are both registered above.
    //
    // Heuristic, and deliberately so — the check is a prompt for review, not a
    // proof. What it can catch is the mechanical tell: a prompt that ASKS
    // ABOUT THE PRESENCE OF A PROBLEM, where "yes" is the bad answer.
    const PROBLEM_LEAD = /^(is|are|does|do|any|has|have)\b.*\b(damage|leak|crack|hazard|problem|issue|missing|broken|expired|pest|mold|mould)\b/i

    for (const form of INSPECTION_FORMS) {
      for (const section of form.sections) {
        if (section.key === SIGNOFF_SECTION_KEY) continue
        for (const item of walkItems(section.items)) {
          if (INVERTED_POLARITY_ITEMS.has(item.key)) continue
          if (item.response_type && item.response_type !== 'yes_no') continue

          expect(PROBLEM_LEAD.test(item.prompt), [
            `${item.key} reads as a question whose YES is the failure:`,
            `  "${item.prompt}"`,
            '',
            'Rephrase it as the condition that SHOULD hold ("No active leaks under',
            'sinks"), or register it in INVERTED_POLARITY_ITEMS with a reason.',
          ].join('\n')).toBe(false)
        }
      }
    }
  })

  it('registered polarity exceptions still exist', () => {
    // An exemption for an item that has been renamed or deleted is an exemption
    // silently covering nothing — and the next item to need one gets added to a
    // list that already looks populated.
    const keys = new Set(INSPECTION_FORMS.flatMap((f) => allItems(f).map((i) => i.key)))
    for (const k of INVERTED_POLARITY_ITEMS) {
      expect(keys.has(k), `INVERTED_POLARITY_ITEMS names ${k}, which no form defines`).toBe(true)
    }
  })

  it('children and repeat groups are structurally sound', () => {
    for (const form of INSPECTION_FORMS) {
      for (const item of allItems(form)) {
        const nested = [...(item.children ?? []), ...(item.repeats ?? [])]
        for (const child of nested) {
          // One level. A grandchild is expressible in the schema and has never
          // been designed for in the renderer or the report.
          expect(child.children ?? [], `${child.key} is a grandchild`).toEqual([])
          expect(child.repeats  ?? [], `${child.key} nests a repeat group`).toEqual([])
        }
        // show_when is meaningless without a parent to answer it.
        if (item.show_when) {
          const isChild = INSPECTION_FORMS.some((f) =>
            allItems(f).some((p) => (p.children ?? []).some((c) => c.key === item.key)))
          expect(isChild, `${item.key} sets show_when but is not a child`).toBe(true)
        }
      }
      // A repeat group must hang off a `count`, which is what sizes it.
      for (const item of allItems(form)) {
        if (!item.repeats?.length) continue
        expect(item.response_type, `${item.key} has a repeat group but is not a count`).toBe('count')
      }
    }
  })

  it('photo_required items are photo-typed, and photo items are never yes_no', () => {
    for (const form of INSPECTION_FORMS) {
      for (const item of allItems(form)) {
        if (!item.photo_required) continue
        expect(item.response_type, `${item.key} requires a photo but is ${item.response_type ?? 'yes_no'}`)
          .toBe('photo')
      }
    }
  })

  it('repeat_per_asset items resolve their asset at render, not at seed time', () => {
    for (const form of INSPECTION_FORMS) {
      for (const item of allItems(form)) {
        if (!item.repeat_per_asset) continue
        // Pinning an asset_type would defeat the point: the row exists once per
        // ACTIVE ledger row of whatever type, not once for a type we chose.
        expect(item.asset_type, `${item.key} repeats per asset and must not pin an asset_type`)
          .toBeUndefined()
      }
    }
  })

  // ── concern_key: the strict half ──────────────────────────────────────────

  it('CONCERN_KEY_MAP matches the definitions exactly, in both directions', () => {
    const inUse = concernKeysInUse()

    // Direction 1: nothing carried by an item is missing from the table.
    for (const [key, items] of inUse) {
      const entry = CONCERN_KEY_MAP[key]
      expect(entry, [
        `concern_key "${key}" is carried by ${items.join(', ')} but is not in CONCERN_KEY_MAP.`,
        '',
        'Add it with a `why`. An unlisted key is a merge nobody reviewed — and a',
        'wrong merge folds two real work orders into one and hides the second.',
      ].join('\n')).toBeDefined()
      expect([...items].sort(), `CONCERN_KEY_MAP["${key}"].items is out of date`)
        .toEqual([...entry!.items].sort())
    }

    // Direction 2: nothing in the table has stopped being used. A stale entry
    // is worse than an absent one — it documents a merge that is not happening.
    for (const key of Object.keys(CONCERN_KEY_MAP)) {
      expect(inUse.has(key), `CONCERN_KEY_MAP["${key}"] is not carried by any item — remove it`)
        .toBe(true)
    }
  })

  it('every concern entry explains itself', () => {
    for (const [key, entry] of Object.entries(CONCERN_KEY_MAP)) {
      expect(entry.items.length, `${key} lists no items`).toBeGreaterThan(0)
      expect(new Set(entry.items).size, `${key} repeats an item`).toBe(entry.items.length)
      // Long enough to be a reason rather than a restatement of the key.
      expect(entry.why.length, `${key} needs a real justification, not a label`).toBeGreaterThan(50)
    }
  })

  it('a concern_key never merges two identical prompts WITHIN one form', () => {
    // Scoped to one form on purpose, and the first draft of this check got it
    // wrong by not being: it flagged egress_window, where Safety 11 and Indoor 5
    // are word-for-word identical.
    //
    // That is not a copy-paste, it is the entire point of §12.2's deliberate
    // overlap — the SAME question asked on a faster cadence, with the shared key
    // there to stop the second asking from producing a second work order. Across
    // forms, identical wording under one key is the design.
    //
    // Within ONE form it is not: the same words twice in one walk is a
    // duplicated row, and merging them hides that rather than fixing it.
    for (const [key, entry] of Object.entries(CONCERN_KEY_MAP)) {
      const byForm = new Map<string, string[]>()
      for (const itemKey of entry.items) {
        const form = itemKey.split('.')[0]!
        byForm.set(form, [...(byForm.get(form) ?? []), findItem(itemKey).prompt])
      }
      for (const [form, prompts] of byForm) {
        expect(new Set(prompts).size, `${key} merges two identical prompts inside ${form}`)
          .toBe(prompts.length)
      }
    }
  })

  it('items with an IDENTICAL prompt across forms share a concern_key', () => {
    // The other half of §12.3's rule. Same words on two forms and no shared key
    // is the missed-merge case: two work orders for one fault.
    const byPrompt = new Map<string, ItemDefinition[]>()
    for (const form of INSPECTION_FORMS) {
      for (const item of allItems(form)) {
        if (item.response_type && item.response_type !== 'yes_no') continue
        // repeat_per_asset rows are excluded here and forbidden a concern_key
        // outright below — see that test for why.
        if (item.repeat_per_asset) continue
        // An item that produces NO record has nothing to deduplicate, so an
        // identical prompt on two forms cannot become two work orders. This is
        // what exempts the sign-off attestations, which are word-for-word
        // identical on Indoor and Outdoor by design. `notify` items stay in
        // scope: they do produce a record, and two of them would double-notify.
        if (item.remediation === 'none') continue
        const norm = item.prompt.toLowerCase().replace(/\s+/g, ' ').trim()
        byPrompt.set(norm, [...(byPrompt.get(norm) ?? []), item])
      }
    }
    for (const [prompt, items] of byPrompt) {
      if (items.length < 2) continue
      const keys = new Set(items.map((i) => i.concern_key ?? '(none)'))
      expect(keys.size === 1 && !keys.has('(none)'), [
        `These items ask the same question and do not share one concern_key:`,
        `  "${prompt}"`,
        ...items.map((i) => `  ${i.key} -> ${i.concern_key ?? '(none)'}`),
      ].join('\n')).toBe(true)
    }
  })

  it('a repeat_per_asset item never carries a concern_key', () => {
    // Found by the identical-prompt check above, which flagged Indoor and
    // Outdoor's asset-condition rows as a missed merge. They are not one — and
    // giving them a shared key would have been an actively harmful fix.
    //
    // A concern_key is STATIC and these rows' subject is not: the same row is
    // rendered once per ACTIVE property_assets entry, so one key would merge
    // "the refrigerator is dead" with "the generator is dead" into a single
    // work order purely because both were asked by the same template row.
    // That is precisely the silent wrong-merge §12.3 says is worse than a
    // duplicate. Per-asset dedup is already handled, by asset_id on the answer.
    for (const form of INSPECTION_FORMS) {
      for (const item of allItems(form)) {
        if (!item.repeat_per_asset) continue
        expect(item.concern_key, [
          `${item.key} repeats per asset and must not carry a concern_key.`,
          'The key is static and the asset is not, so it would merge faults on',
          'unrelated assets. Dedup for these rows is asset_id, not concern_key.',
        ].join('\n')).toBeUndefined()
      }
    }
  })

  it('SELF-CHECK: the concern scan sees the definitions it claims to', () => {
    // A guardrail at zero because it walked nothing looks exactly like one at
    // zero because the data is clean.
    const inUse = concernKeysInUse()
    expect(inUse.size, 'no concern keys found — has the walk broken?').toBeGreaterThanOrEqual(25)

    // The three-form case really is present and really is three.
    expect(inUse.get('dryer_vent_clear')?.length).toBe(3)
    // And the within-form symptom merge, which is the subtler of the two uses.
    expect(inUse.get('well_short_cycle')?.length).toBe(3)

    // The near-misses §12.3 calls out are still SEPARATE. If either of these
    // ever collapses into one key, two real work orders become one.
    expect(inUse.has('hvac_filter') && inUse.has('hvac_condenser')).toBe(true)
    expect(inUse.has('pest_activity') && inUse.has('exterior_pest')).toBe(true)
  })
})

function findItem(key: string): ItemDefinition {
  for (const form of INSPECTION_FORMS) {
    const found = allItems(form).find((i) => i.key === key)
    if (found) return found
  }
  throw new Error(`CONCERN_KEY_MAP references unknown item key: ${key}`)
}

describe('inspection form conditional sections', () => {
  it('conditional sections declare exactly one gate', () => {
    for (const form of INSPECTION_FORMS) {
      for (const section of form.sections) {
        const gates = [section.shown_when_asset, section.shown_when_property_field].filter(Boolean)
        expect(gates.length, `${form.key}.${section.key} declares two gates`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('the well section is ledger-gated and the HOA section is field-gated', () => {
    // Named explicitly because the DIFFERENCE is the point: a ledger-backed
    // skip cannot be asserted by whoever benefits from skipping it.
    const outdoor = FORMS_BY_KEY.outdoor!
    const well = outdoor.sections.find((s) => s.key === 'well')
    const hoa  = outdoor.sections.find((s) => s.key === 'hoa')

    expect(well?.shown_when_asset).toBe('well_pump')
    expect(hoa?.shown_when_property_field).toBe('hoa_name')
  })
})
