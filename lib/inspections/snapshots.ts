// lib/inspections/snapshots.ts
//
// The two things an inspection freezes at START, and why each has to be frozen
// rather than joined to at read time.
//
// Both are pure functions over rows. Nothing here reads a database or a network,
// which is what lets the whole snapshot contract be tested without either.

import type {
  InspectionFormItem,
  InspectionFormSection,
  Property,
} from '@/types/database'

// ── The form, as it was asked ───────────────────────────────────────────────

/**
 * §5: "Re-seeding must not retroactively change what a completed inspection
 * says it asked: a reworded item shipping in March cannot be allowed to rewrite
 * what January's report claims."
 *
 * The seed upserts by key and re-runs on every merge that touches the
 * definitions, so the live rows genuinely do move. `inspection_items` carries
 * its own `prompt_snapshot` per answer for the same reason at row grain; this
 * is the whole-form counterpart, and it is what lets a historical report
 * re-render the sections and ordering it was actually walked in — including
 * items that have since been reworded or removed.
 */
// `type`, not `interface`, on both snapshots. TypeScript gives an object type
// alias an implicit index signature and denies one to an interface, so only the
// alias is assignable to `Json` — which these must be, because they are written
// straight into a jsonb column. Better than the `as unknown as Json` double
// assertion that would otherwise be needed, since that would suppress a real
// shape mismatch just as readily as this one.
/**
 * A structural MIRROR of the row, as a mapped type.
 *
 * `InspectionFormItem` is an interface, and an interface nested inside a
 * Json-assignable alias re-breaks the assignability the alias just bought. A
 * mapped type over it — `{ [K in keyof T]: T[K] }` — is an alias, so it carries
 * the implicit index signature, and it tracks every field of the row
 * automatically. Hand-listing the columns instead would work today and drift
 * the first time one is added, silently dropping it from every snapshot.
 */
type SnapshotItem = { [K in keyof InspectionFormItem]: InspectionFormItem[K] }

export type FormSnapshot = {
  form_key:     string
  form_version: number
  captured_at:  string
  sections: {
    id:                string
    key:               string
    name:              string
    sort_order:        number
    shown_when_asset:  string | null
    items:             SnapshotItem[]
  }[]
}

export function buildFormSnapshot(
  formKey:     string,
  formVersion: number,
  sections:    InspectionFormSection[],
  items:       InspectionFormItem[],
  capturedAt:  string,
): FormSnapshot {
  const bySection = new Map<string, InspectionFormItem[]>()
  for (const item of items) {
    bySection.set(item.section_id, [...(bySection.get(item.section_id) ?? []), item])
  }

  return {
    form_key:     formKey,
    form_version: formVersion,
    captured_at:  capturedAt,
    sections: [...sections]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({
        id:               s.id,
        key:              s.key,
        name:             s.name,
        sort_order:       s.sort_order,
        shown_when_asset: s.shown_when_asset,
        // Sorted here, not left to the reader: the snapshot's job is to record
        // the order the form was WALKED IN, and an unordered blob would make a
        // re-render depend on jsonb key order.
        items: (bySection.get(s.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order),
      })),
  }
}

// ── The letterhead, as it was ───────────────────────────────────────────────

/**
 * §5: every field on the letterhead is derived from a live row that can change,
 * "and an ownership transfer silently rewriting the letterhead on three years of
 * past reports would mean the document no longer says what it said."
 *
 * The weather half is §12.3's, and the distinction it draws is the reason this
 * type has a `source` rather than just a string. "Conditions: 41°F, light rain
 * (recorded)" is a different claim from "Conditions: overcast (reported)", and
 * printing them identically would quietly launder one into the other.
 */
export type HeaderSnapshot = {
  property_name:    string
  property_address: string
  org_name:         string
  /** The org owner, for the letterhead. NOT the inspector — see §5. */
  org_owner_name:   string | null
  captured_at:      string
  conditions:       ConditionsSnapshot | null
}

export type ConditionsSnapshot =
  | { source: 'recorded'; temperature_f: number; label: string; is_rainy: boolean; is_snowy: boolean }
  /** Typed by the inspector, because the lookup could not resolve — see below. */
  | { source: 'reported'; text: string }

export interface WeatherLike {
  temperature:  number
  weatherLabel: string
  isRainy:      boolean
  isSnowy:      boolean
}

/**
 * A machine-recorded observation, which is worth more than a self-reported one
 * and costs the inspector nothing.
 *
 * §12.3 is blunt about the caveat: the lookup is Redis-cached and
 * single-flighted, and OFFLINE IT WILL NOT RESOLVE AT ALL — which is precisely
 * when an outdoor inspection is most likely to be happening. So `null` here is
 * an expected outcome, not an error, and the caller falls back to asking.
 */
export function recordedConditions(weather: WeatherLike | null): ConditionsSnapshot | null {
  if (!weather) return null
  return {
    source:        'recorded',
    temperature_f: weather.temperature,
    label:         weather.weatherLabel,
    is_rainy:      weather.isRainy,
    is_snowy:      weather.isSnowy,
  }
}

/** The fallback. Kept as a distinct shape so the report can never conflate them. */
export function reportedConditions(text: string): ConditionsSnapshot | null {
  const trimmed = text.trim()
  return trimmed ? { source: 'reported', text: trimmed } : null
}

export function buildHeaderSnapshot(input: {
  property:     Pick<Property, 'name' | 'address' | 'city' | 'state' | 'zip'>
  orgName:      string
  orgOwnerName: string | null
  conditions:   ConditionsSnapshot | null
  capturedAt:   string
}): HeaderSnapshot {
  const { property } = input
  return {
    property_name:    property.name,
    property_address: formatAddress(property),
    org_name:         input.orgName,
    org_owner_name:   input.orgOwnerName,
    captured_at:      input.capturedAt,
    conditions:       input.conditions,
  }
}

/**
 * One line, empty parts dropped. A frozen letterhead that reads
 * "12 Oak St, , AL 35010" because a city was blank is a worse artifact than one
 * that reads "12 Oak St, AL 35010".
 */
function formatAddress(p: Pick<Property, 'address' | 'city' | 'state' | 'zip'>): string {
  const stateZip = [p.state, p.zip].filter((x) => x?.trim()).join(' ')
  return [p.address, p.city, stateZip]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(', ')
}
