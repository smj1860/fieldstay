import { unwrap } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
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
  // A failed claim returned false, which every caller reads as "already sent
  // today" — so a transient error silently suppressed the guest's SMS with
  // nothing logged. Throwing lets the cron retry; the retry re-reads the
  // date column, so it still cannot double-send.
  const claimRes = await supabase
    .from('guidebook_guest_sms_optins')
    .update({ [dateColumn]: todayDate, updated_at: new Date().toISOString() })
    .eq('id', optinId)
    .or(`${dateColumn}.is.null,${dateColumn}.lt.${todayDate}`)
    .select('id')
    .maybeSingle()

  return Boolean(unwrap(claimRes, { site: 'lib.sms.optin-claim' }))
}

/** Rolls back a claim after a failed send so the next run can retry. */
export async function releaseDailySmsSlot(
  supabase: SupabaseClient,
  optinId: string,
  dateColumn: DailySmsDateColumn
): Promise<void> {
  const { error } = await supabase
    .from('guidebook_guest_sms_optins')
    .update({ [dateColumn]: null })
    .eq('id', optinId)

  if (error) {
    console.error('[releaseDailySmsSlot]', error.message)
    reportError(error, { site: 'lib.sms.optin-claim.release', extra: { date_column: dateColumn } })
  }
}

/**
 * Claim → send → release-on-EITHER-failure, as one unit.
 *
 * The claim and the release already lived here; the sequence that ties them
 * together did not, and all three guest-nudge call sites (two morning
 * branches, one evening) had independently written the same HALF of it:
 *
 *     const res = await sendSMS(...)
 *     if (!res.sent) await releaseDailySmsSlot(...)
 *     return res.sent
 *
 * `sendSMS` returns `{sent:false}` ONLY for a deliberate skip — SMS_ENABLED
 * off, the daily nudge budget, demo-org suppression. Every REAL failure
 * throws, because dispatchToTelnyx throws on a timeout or any non-2xx. So the
 * one branch that was written handled the case that isn't a failure, and the
 * throw walked out past the release with the day's slot still claimed. The
 * Inngest retry then re-read the date column, found today's date, skipped —
 * and that guest's nudge was silently gone for the day.
 *
 * Callers get a plain boolean back, so the shape at each site is unchanged.
 */
export async function sendClaimedDailySms(
  supabase: SupabaseClient,
  optinId: string,
  dateColumn: DailySmsDateColumn,
  todayDate: string,
  send: () => Promise<{ sent: boolean }>,
): Promise<boolean> {
  const claimed = await claimDailySmsSlot(supabase, optinId, dateColumn, todayDate)
  if (!claimed) return false

  let res: { sent: boolean }
  try {
    res = await send()
  } catch (err) {
    await releaseDailySmsSlot(supabase, optinId, dateColumn)
    throw err
  }

  if (!res.sent) await releaseDailySmsSlot(supabase, optinId, dateColumn)
  return res.sent
}
