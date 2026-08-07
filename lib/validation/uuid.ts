// lib/validation/uuid.ts
//
// The UUID shape check, in one place.
//
// Every id this app puts into a `.eq()` is a Postgres `uuid` column, and
// Postgres does not coerce — a non-UUID string is error 22P02 ("invalid input
// syntax for type uuid"), not an empty result. What that error becomes depends
// entirely on where it lands:
//
//   - through unwrap(), it throws — which in a public route means a Sentry
//     report per malformed request, so anyone can burn the quota and bury the
//     real DB failures on that route under noise;
//   - destructured as `{ data }`, it silently reads as "no such row".
//
// Neither is what the caller meant. A malformed id is a BAD REQUEST and
// belongs to input validation at the boundary — the item CLAUDE.md's manual
// audit checklist lists as having no mechanical guardrail.
//
// This regex was independently open-coded in four files before this module
// existed (two crew routes, the crew work-order complete route, and
// lib/storage/object-path.ts) and was simply missing from the fifth place that
// needed it. Five copies is how the sixth one gets forgotten too.
//
// Deliberately NOT `import 'server-only'`: a pure predicate over a string,
// usable from a Client Component that wants to reject input before a round
// trip. Same rationale as lib/storage/object-path.ts and lib/supabase/unwrap.ts.

/**
 * Matches the canonical 8-4-4-4-12 hex form, case-insensitively.
 *
 * Intentionally not version- or variant-aware: the job is to keep malformed
 * input out of a `uuid` column, and Postgres accepts any 8-4-4-4-12 hex string
 * regardless of the version nibble. A stricter pattern would reject ids
 * Postgres itself considers valid.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when `value` is a string Postgres will accept for a `uuid` column. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
