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
  bedrooms:        number
  bathrooms:       number | null
  max_guests:      number
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
