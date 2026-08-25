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
import type { ResolvableSection } from './resolve-form'

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

/**
 * Read a stored `form_snapshot` back, defensively.
 *
 * This is the fill screen's ONLY source for the form — not a join to
 * `inspection_form_items`. Three things follow from that and all three are the
 * point: it works with no connection, a re-seed mid-walk cannot change the
 * questions under the inspector, and a historical report re-renders through the
 * exact same code path as a live one.
 *
 * `Json` in, so nothing about the shape can be assumed. A malformed snapshot
 * returns null and the caller says so, rather than throwing halfway through a
 * render or — far worse — silently resolving to a shorter form.
 */
export function parseFormSnapshot(value: unknown): FormSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  if (typeof raw.form_key !== 'string' || typeof raw.form_version !== 'number') return null
  if (!Array.isArray(raw.sections)) return null

  const sections: FormSnapshot['sections'] = []
  for (const entry of raw.sections) {
    if (!entry || typeof entry !== 'object') return null
    const s = entry as Record<string, unknown>
    if (typeof s.id !== 'string' || typeof s.key !== 'string' || typeof s.name !== 'string') return null
    if (typeof s.sort_order !== 'number' || !Array.isArray(s.items)) return null

    sections.push({
      id:               s.id,
      key:              s.key,
      name:             s.name,
      sort_order:       s.sort_order,
      shown_when_asset: typeof s.shown_when_asset === 'string' ? s.shown_when_asset : null,
      items:            s.items as SnapshotItem[],
    })
  }

  return {
    form_key:     raw.form_key,
    form_version: raw.form_version,
    captured_at:  typeof raw.captured_at === 'string' ? raw.captured_at : '',
    sections,
  }
}

/**
 * The snapshot, flattened into what `resolveFormPages` takes.
 *
 * The items come back as ONE flat list because that is the shape the resolver
 * indexes — it re-derives parents, repeat groups and per-asset rows itself, so
 * handing it a pre-nested tree would mean two implementations of the same
 * bucketing and one of them going stale.
 */
export function formFromSnapshot(snapshot: FormSnapshot): {
  sections: ResolvableSection[]
  items:    InspectionFormItem[]
} {
  return {
    sections: snapshot.sections.map((s) => ({
      id:               s.id,
      key:              s.key,
      name:             s.name,
      sort_order:       s.sort_order,
      shown_when_asset: s.shown_when_asset,
    })),
    items: snapshot.sections.flatMap((s) => s.items),
  }
}

/**
 * Form item ids the snapshot marks `remediation: 'none'` — the record-only ones.
 *
 * A few items exist to STATE A FACT rather than to judge a condition:
 * "Trampoline, playground or diving board present at this property",
 * "Monitored alarm or security system present". They answer through the same
 * Pass/Fail control as everything else, so "no alarm" records as a `fail` — and
 * most short-term rentals have no alarm. Treated as findings, a report would
 * show "no repair or purchase raised" against a question whose honest answer
 * was simply no.
 *
 * Read from the SNAPSHOT, so a re-worded or re-classified item cannot
 * retroactively change what a completed walk shows. `'notify'` is deliberately
 * NOT included: a lapsed STR permit raises no work order and is still something
 * a reader should see.
 *
 * An UNPARSEABLE snapshot yields an empty set, so every answer is treated as a
 * check. That is the safe direction — the failure mode is one extra line, not a
 * silently hidden finding, and hiding is the one this must never do by
 * accident. An item absent from the snapshot behaves the same way, for the same
 * reason.
 */
export function recordOnlyItemIds(parsed: FormSnapshot | null): Set<string> {
  const ids = new Set<string>()
  if (!parsed) return ids

  for (const section of parsed.sections) {
    for (const item of section.items) {
      if (item.remediation === 'none') ids.add(item.id)
    }
  }
  return ids
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
