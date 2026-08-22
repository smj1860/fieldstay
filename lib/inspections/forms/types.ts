// lib/inspections/forms/types.ts
//
// The shape of a platform-owned inspection form definition.
//
// WHY THE DEFINITION LIVES IN THE REPO AT ALL
//
// docs/INSPECTIONS_SPEC.md §9 "Where the form definition lives" settled this:
// `inventory_catalog` is the precedent for SHAPE (global rows, no org_id) and
// `scripts/seed-support-kb.ts` is the precedent for PROCESS (content in the
// repo, a script projects it into Postgres, CI re-runs on change). Both, so a
// reworded item is a reviewable diff rather than a migration, and the
// `form_item_id` foreign key that repeat-visit dedup depends on still exists at
// the other end.
//
// WHY SO MANY FIELDS ARE REQUIRED HERE WHEN THE COLUMN IS NULLABLE
//
// `remediation` and `default_actions` are both optional in the DATABASE — the
// column has a default. They are mandatory in THIS type on purpose. The spec's
// authoring rule is that every item carries a remediation decision, and a
// default silently converts "the author had not decided" into "work order",
// which is the one outcome nobody chose. Requiring them moves that check from
// a test that runs after the fact to `tsc`, which runs before the file can
// even be saved in a working state.
//
// The same reasoning does NOT apply to `wo_category`, which is optional: the
// spec assigns one per item only implicitly, and inventing a routing category
// for an item the spec never categorised would be guessing with a straight
// face. Where it is known it is stated; where it is not, the work-order
// creation path picks, exactly as it does for every other WO source.

import type {
  AssetType,
  InspectionAction,
  InspectionRemediation,
  InspectionResponseType,
  InspectionResult,
  PriorityLevel,
  WoCategory,
} from '@/types/database'

export interface ItemDefinition {
  /**
   * Fully qualified and STABLE across re-seeds: `safety.fire.smoke_present`.
   * The row id is not stable; this is. Every answer ever recorded points at the
   * row this key resolves to, so renaming one is a data migration, not an edit.
   *
   * The DB uniqueness is (section_id, key), so only the leaf would have to be
   * unique. Fully qualifying it anyway makes the key self-describing in a work
   * order, a report and a `concern_key` cross-reference — and makes a
   * copy-paste between forms fail the duplicate check instead of silently
   * resolving to a different section's item.
   */
  key:    string
  prompt: string

  /** Defaults to `yes_no` at the DB level; stated here only when it differs. */
  response_type?: InspectionResponseType
  /** Defaults to true at the DB level; stated here only when it differs. */
  is_required?:   boolean
  photo_required?: boolean

  /**
   * What KIND of record a failure can produce. REQUIRED — see the header.
   * 'none' and 'notify' never dispatch.
   */
  remediation: InspectionRemediation
  /**
   * Pre-ticked action chips on a fail. REQUIRED, and `[]` is a real answer:
   * every record-only and notify item has no action to pre-tick, and the DB
   * CHECK constraint enforces that pairing.
   */
  default_actions: InspectionAction[]

  wo_category?: WoCategory
  /**
   * Set ONLY where the spec argues for urgency in its own prose (life safety,
   * a legal requirement, a live gas or water risk). Left unset elsewhere rather
   * than assigning ~100 priority judgments the spec never made — an invented
   * priority is worse than none, because it looks deliberate.
   */
  wo_priority?: PriorityLevel

  /** Attribute the answer to a `property_assets` row of this type. */
  asset_type?:    AssetType
  /** Verify an N/A claim against the asset ledger instead of taking it on trust. */
  na_asset_type?: AssetType
  na_reason_template?: string

  /** Shared across forms — see the CONCERN_KEY_MAP table in ./index.ts. */
  concern_key?: string

  /** One row per ACTIVE `property_assets` row; `asset_type` resolved at render. */
  repeat_per_asset?: boolean

  /** Shown only when the PARENT answers this. Set on children, never on a root. */
  show_when?: InspectionResult
  /** Conditional follow-ups: "→ which room?" exists only because the parent failed. */
  children?: ItemDefinition[]
  /** One group per unit counted at THIS item (N extinguishers → N groups). */
  repeats?:  ItemDefinition[]
}

export interface SectionDefinition {
  key:   string
  name:  string
  items: ItemDefinition[]
  /**
   * Rendered only when the property has an ACTIVE asset of this type. Outdoor's
   * well section is the case: a municipal-water property never sees it, and the
   * skip is ledger-backed rather than inspector-asserted.
   */
  shown_when_asset?: AssetType
  /**
   * Rendered only when this property column is non-null. Outdoor's HOA section
   * is the only user — `properties.hoa_name`.
   */
  shown_when_property_field?: 'hoa_name'
}

export interface FormDefinition {
  key:         'safety' | 'indoor' | 'outdoor'
  name:        string
  description: string
  /**
   * Bumped when an item's WORDING or MEANING changes. Re-seeding upserts on
   * (key, version), so a new version is a new row set and a completed
   * inspection keeps pointing at the rows it actually asked. Never edit a
   * shipped version in place — `form_snapshot` would still be right and the
   * live rows would have quietly moved out from under it.
   */
  version:  number
  sections: SectionDefinition[]
}

/** Depth-first walk over roots, their children and their repeat groups. */
export function walkItems(items: ItemDefinition[]): ItemDefinition[] {
  const out: ItemDefinition[] = []
  for (const item of items) {
    out.push(item)
    if (item.children) out.push(...walkItems(item.children))
    if (item.repeats)  out.push(...walkItems(item.repeats))
  }
  return out
}

/** Every item on a form, in definition order, flattened. */
export function allItems(form: FormDefinition): ItemDefinition[] {
  return form.sections.flatMap((s) => walkItems(s.items))
}

/** Top-level items only — what the spec's "40 items across 6 sections" counts. */
export function rootItems(form: FormDefinition): ItemDefinition[] {
  return form.sections.flatMap((s) => s.items)
}
