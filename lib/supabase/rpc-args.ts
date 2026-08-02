// lib/supabase/rpc-args.ts
// ============================================================
// Passing NULL to a Postgres function parameter that accepts it.
// ============================================================

/**
 * Marks an RPC argument whose function genuinely accepts NULL.
 *
 * `supabase gen types` derives each function's `Args` from pg_proc, and
 * pg_proc records no nullability for parameters — so every `text`/`uuid`
 * argument comes out typed non-null even when the function's own body
 * branches on `IS NULL` (store_property_door_code) or simply stores the value
 * into a nullable column (create_organization_with_owner.p_billing_email).
 *
 * This is the one place that gap is asserted. Using it keeps the assertion
 * named and greppable instead of scattering bare `as string` casts across
 * call sites, where they would be indistinguishable from a real type error
 * someone silenced.
 *
 * Only use it when the function truly accepts NULL for that parameter —
 * check `pg_get_function_arguments` and the function body first. If the
 * argument is DEFAULT NULL and "absent" means the same thing, prefer OMITTING
 * it: the generated type already makes those optional.
 */
export function nullableArg<T>(value: T | null | undefined): T {
  return value as T
}
