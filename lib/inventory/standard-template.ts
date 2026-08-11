import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { tryUnwrap, type QueryContext } from '@/lib/supabase/unwrap'

/**
 * The ONE platform inventory template marked as the standard, or null if a
 * platform admin has not designated one yet.
 *
 * Legs 2 and 3 of auto-apply (org signup, property creation) both start here.
 * Null is an ordinary, expected state — not an error — and every caller must
 * treat it as "there is nothing to apply, carry on". Signup and property
 * creation must never fail because the platform has not picked a standard
 * template; inventory is an enhancement to those flows, not a precondition.
 *
 * `.maybeSingle()` rather than `.single()` for the same reason: zero rows is
 * the no-standard-set case, and `.single()` would turn it into a PGRST116
 * error that every call site then has to special-case.
 *
 * At most one row can match — enforced by the partial unique index
 * platform_inventory_templates_one_default, so this cannot silently pick an
 * arbitrary winner among several.
 */
export async function getStandardInventoryTemplateId(
  supabase: SupabaseClient,
  context: QueryContext,
): Promise<string | null> {
  // The row type goes on tryUnwrap, NOT as `.maybeSingle<{ id: string }>()`.
  // A generic type argument there stops semgrep's `$X.maybeSingle(...)`
  // exemption from matching, so both the unbounded-select and
  // discarded-result chokepoints fire on a read that is in fact bounded and
  // handled. Same result, no false positive.
  const res = await supabase
    .from('platform_inventory_templates')
    .select('id')
    .eq('is_default', true)
    .maybeSingle()

  const result = tryUnwrap<{ id: string }>(res, context)

  // tryUnwrap reports the failure; a read error here must not take down the
  // signup or property-create flow that called us.
  if (!result.ok) return null
  return result.data?.id ?? null
}
