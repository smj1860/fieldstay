// lib/inspections/forms/shared-sections.ts
//
// The two sections Indoor and Outdoor share verbatim.
//
// docs/INSPECTIONS_SPEC.md says so in its own words — §12.3 §7 is "Same as
// Indoor §7" and its sign-off is "Identical to Indoor" — and until now that was
// a promise kept by two copies of the same literal. Two copies that must stay
// identical, with nothing enforcing it, is the drift this codebase pays for
// most often: the next person to reword the certification statement rewords one
// of them, both keep passing every test, and the two forms quietly stop making
// the same attestation.
//
// Parameterised by form key ONLY, because that is the only thing that legibly
// differs — the item keys are namespaced `<form>.<section>.<leaf>` and every
// other field is shared. If a future difference is needed, add a real argument
// for it rather than forking the builder; a fork puts us back where we started.

import type { ItemDefinition, SectionDefinition } from './types'

/** Forms that carry these sections. Safety deliberately has neither — see §12.1. */
export type SharedSectionForm = 'indoor' | 'outdoor'

/**
 * Rendered from the asset ledger, not written here. Every ACTIVE
 * `property_assets` row whose type is not already covered by a named item
 * produces one row, so a property with three HVAC units is asked three times
 * and one with no generator is never asked about a generator.
 *
 * No `concern_key`, and that is enforced by the seed test rather than left to
 * memory: the key would be static and the subject is not, so one key would
 * merge a dead refrigerator with a dead generator purely because both came from
 * this row. Per-asset dedup is `asset_id` on the answer.
 */
export function assetsSection(form: SharedSectionForm): SectionDefinition {
  return {
    key:  'assets',
    name: 'Property Assets',
    items: [
      {
        key:    `${form}.assets.condition`,
        prompt: 'Operational, no visible damage, no unusual noise or smell',
        repeat_per_asset: true,
        remediation: 'work_order', default_actions: ['service'],
        wo_category: 'general',
        children: [{
          key:    `${form}.assets.plate_photo`,
          prompt: 'Serial/model plate photo',
          response_type: 'photo', photo_required: true,
          remediation: 'none', default_actions: [],
        }],
      },
    ],
  }
}

/**
 * Cleaning roll-up, certification, signature.
 *
 * On Indoor these are items 50–52; on Outdoor they are unnumbered but identical.
 * Outdoor's cleaning roll-up collects pressure-washing, gutter clearing and
 * grounds cleanup where Indoor's collects interior work — same mechanism, and
 * the difference is in which items were ticked, not in the question.
 */
export function signoffSection(form: SharedSectionForm): SectionDefinition {
  const cleaningDetail: ItemDefinition = {
    // DELIBERATELY NOT `show_when`. The three values are pass/fail/na, and the
    // parent is one of the two items on any form where "yes" is not "everything
    // is fine" — yes means more work is needed. `show_when: 'pass'` would be
    // mechanically correct and read to every future human as its exact
    // opposite. It is optional anyway ("the prefill is usually enough"), so the
    // render condition belongs in the UI, where the inversion is visible.
    key:    `${form}.signoff.cleaning_detail`,
    prompt: 'What needs cleaning',
    response_type: 'text', is_required: false,
    remediation: 'none', default_actions: [],
  }

  return {
    key:  'signoff',
    name: 'Sign-off',
    items: [
      {
        // Produces at most ONE work order, `wo_category: 'cleaning'`, crew-
        // assigned, with the suggested cleaner count from §5. Pre-answered
        // `yes` if any item was flagged Cleaning, with notes prefilled from
        // those descriptions.
        //
        // `remediation: 'none'` because the roll-up is its own path: it is not
        // one of the per-item Repair/Service/Replace records, and routing it
        // through them would produce N dispatches for one visit.
        key:    `${form}.signoff.additional_cleaning`,
        prompt: 'Does additional cleaning need to be scheduled?',
        remediation: 'none', default_actions: [],
        children: [cleaningDetail],
      },
      {
        key:    `${form}.signoff.certification`,
        prompt: 'Certification — inspection completed on-site; all exceptions recorded with photos',
        remediation: 'none', default_actions: [],
      },
      {
        key:    `${form}.signoff.signature`,
        prompt: 'Inspector signature',
        response_type: 'photo', photo_required: true,
        remediation: 'none', default_actions: [],
      },
    ],
  }
}
