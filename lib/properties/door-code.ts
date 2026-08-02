// lib/properties/door-code.ts
// ============================================================
// Argument shaping for the store_property_door_code RPC.
// ============================================================

import { nullableArg } from '@/lib/supabase/rpc-args'

/**
 * Args for `store_property_door_code`.
 *
 * `p_door_code` genuinely accepts NULL: the function branches on
 * `IF p_door_code IS NULL` to delete the Vault secret and clear
 * properties.door_code_secret_id — that is how a PM removes a door code. The
 * generated Args type says `string` only because a Postgres function's
 * parameters carry no nullability in the catalog, so `supabase gen types`
 * cannot express a nullable argument.
 *
 * The assertion is scoped to this one shape so no call site repeats it, and
 * so the reason lives in exactly one place.
 */
export function doorCodeArgs(propertyId: string, orgId: string, doorCode: string | null) {
  return {
    p_property_id: propertyId,
    p_org_id:      orgId,
    p_door_code:   nullableArg(doorCode),
  }
}
