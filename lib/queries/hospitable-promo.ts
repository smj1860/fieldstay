import { createClient } from '@/lib/supabase/server'

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

  if (error) {
    console.error(`Failed to load Hospitable promo status for org ${orgId}:`, error.message)
    return null
  }

  if (!data) return null

  return {
    priceLockActive:    data.price_lock_active,
    priceLockSequence:  data.price_lock_sequence,
    priceLockYears:     data.price_lock_years,
    priceLockTier:      data.price_lock_tier,
    priceLockExpiresAt: data.price_lock_expires_at,
  }
}
