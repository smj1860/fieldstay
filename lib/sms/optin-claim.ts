import type { SupabaseClient } from '@supabase/supabase-js'

type DailySmsDateColumn = 'last_morning_sms_date' | 'last_evening_sms_date'

/**
 * Atomically claims a guest's daily SMS slot before sending. Mirrors the
 * `IS NULL OR < today` eligibility filter used to select candidates, so a
 * step retry after a successful send finds the slot already claimed (the
 * date column no longer matches the filter) and skips re-sending instead
 * of texting the guest twice. Returns true if this call won the claim.
 */
export async function claimDailySmsSlot(
  supabase: SupabaseClient,
  optinId: string,
  dateColumn: DailySmsDateColumn,
  todayDate: string
): Promise<boolean> {
  const { data } = await supabase
    .from('guidebook_guest_sms_optins')
    .update({ [dateColumn]: todayDate, updated_at: new Date().toISOString() })
    .eq('id', optinId)
    .or(`${dateColumn}.is.null,${dateColumn}.lt.${todayDate}`)
    .select('id')
    .maybeSingle()

  return Boolean(data)
}

/** Rolls back a claim after a failed send so the next run can retry. */
export async function releaseDailySmsSlot(
  supabase: SupabaseClient,
  optinId: string,
  dateColumn: DailySmsDateColumn
): Promise<void> {
  await supabase
    .from('guidebook_guest_sms_optins')
    .update({ [dateColumn]: null })
    .eq('id', optinId)
}
