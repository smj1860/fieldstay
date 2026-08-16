// Shared normalization types for provider property syncs (Hospitable,
// OwnerRez, ...).
//
// Policy: the connected PMS is always the source of truth — every sync
// overwrites every field below, including wifi_name/wifi_password/
// access_instructions/house_manual, which a PM can also hand-edit directly
// in FieldStay (see app/(dashboard)/properties/[id]/setup/details/actions.ts).
// We do NOT block that overwrite (no per-field "PM owns this" tracking) —
// instead, logContentOverwrites() in upsert-normalized.ts writes an
// audit_events entry whenever a sync is about to replace an existing,
// different, non-null value for one of those four fields. This is
// recoverability, not prevention: the PM's edit can still be silently
// replaced, but there's a trail to notice it happened and see what the
// previous value was.

export interface NormalizedPropertyFacts {
  name:            string
  address:         string | null
  city:            string | null
  state:           string | null
  zip:             string | null
  // null means "this PMS has no such field", NOT "zero". Hostex's /properties
  // exposes no bedroom, bathroom or occupancy count at all, and a mapper that
  // invented one re-wrote it over the PM's correction on every re-sync — the
  // provider's fabricated default beating the only real number in the system.
  // upsert-normalized.ts writes a null through as "leave the existing value
  // alone", falling back to FieldStay's own defaults only for a brand-new row.
  bedrooms:        number | null
  bathrooms:       number | null
  max_guests:      number | null
  checkin_time:    string
  checkout_time:   string
  timezone:        string
  amenities:       Record<string, boolean> | null
  smoking_allowed: boolean | null
  pets_allowed:    boolean | null
  events_allowed:  boolean | null
}

// PM-editable content fields. Listed separately from the facts above purely
// for documentation/audit purposes — see logContentOverwrites() — they are
// still written unconditionally in the same upsert as everything else.
export interface NormalizedPropertyContent {
  wifi_name:           string | null
  wifi_password:       string | null
  access_instructions: string | null
  house_manual:        string | null
}

export type NormalizedProperty = NormalizedPropertyFacts & NormalizedPropertyContent & {
  external_id: string
  // Only known when the PMS's own fee/pricing data is directly readable —
  // currently Hospitable's GET /properties `bookings.fees` (📄 spec,
  // unconfirmed against a live response — see
  // docs/Integrations/hospitable/api-reference.md). Deliberately NOT part
  // of the always-overwrite Facts/Content fields above: a PM's own
  // cleaning_cost entry (what FieldStay actually pays a cleaner) can
  // legitimately differ from what the PMS charges guests for cleaning, so
  // this is only ever used to backfill a currently-null value, never to
  // replace an existing one — see backfillCleaningCost() in
  // upsert-normalized.ts.
  cleaning_cost?: number | null
  /**
   * Exact coordinates, when the PMS supplies them directly (Hostex's
   * /properties returns latitude/longitude on every property).
   *
   * Preferred over the ZIP geocode fallback in upsert-normalized: it is more
   * precise, costs no Mapbox call, and — for a provider like Hostex that
   * returns one free-form address string rather than structured fields — it
   * is the ONLY way a property gets coordinates at all, since there may be no
   * parseable ZIP to geocode from. Omit (or null) when the provider has none.
   */
  lat?: number | null
  lng?: number | null
}

// Field names in NormalizedPropertyContent that logContentOverwrites()
// compares against the existing row before every sync overwrite.
export const CONTENT_FIELDS = [
  'wifi_name',
  'wifi_password',
  'access_instructions',
  'house_manual',
] as const

// wifi_password is a credential — never write its actual value (old or new)
// into audit_events. Other content fields are plain text and safe to log.
export const REDACTED_CONTENT_FIELDS: ReadonlySet<string> = new Set(['wifi_password'])
