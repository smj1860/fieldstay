import { createClient } from '@/lib/supabase/server'
import { reportQueryError } from '@/lib/supabase/unwrap'

export interface HospitablePromoStatus {
  priceLockActive:    boolean
  priceLockSequence:  number | null
  priceLockYears:     1 | 2 | null
  priceLockTier:      string | null
  priceLockExpiresAt: string | null
}

/** RLS-scoped — org members can only ever read their own org's promo row. */
export async function getHospitablePromoStatus(orgId: string): Promise<HospitablePromoStatus | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('hospitable_launch_promo')
    .select('price_lock_active, price_lock_sequence, price_lock_years, price_lock_tier, price_lock_expires_at')
    .eq('org_id', orgId)
    .maybeSingle()

  // Degrading to "no promo" is the right UX for a marketing banner, but the
  // failure previously only reached the console — never Sentry — so a broken
  // read here was indistinguishable from an org that simply has no promo row.
  if (reportQueryError(error, { site: 'lib.queries.getHospitablePromoStatus', orgId })) {
    return null
  }

  if (!data) return null

  return {
    priceLockActive:    data.price_lock_active,
    priceLockSequence:  data.price_lock_sequence,
    // smallint with CHECK (price_lock_years IN (1, 2)) — a constraint the
    // column's type cannot express, so re-state it here rather than assert.
    priceLockYears:
      data.price_lock_years === 1 || data.price_lock_years === 2
        ? data.price_lock_years
        : null,
    priceLockTier:      data.price_lock_tier,
    priceLockExpiresAt: data.price_lock_expires_at,
  }
}
