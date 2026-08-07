'use server'
import crypto                  from 'crypto'
import { requireOrgRole }      from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { reportError }         from '@/lib/observability/report-error'

/**
 * The columns and rows that actually hold guest PII. This list is the same one
 * lib/inngest/functions/cron/guest-pii-retention.ts clears, and the two MUST
 * stay in step: a manual Article 17 erasure that scrubs less than the automatic
 * retention purge is a compliance record asserting something that did not
 * happen.
 *
 * It shipped clearing two of the five:
 *
 *   guest_name           ✅
 *   guest_email          ✅
 *   raw_ical_data        ❌  the OTA feed payload — carries the guest's name and
 *                            usually their email, verbatim, in jsonb
 *   Vault door code      ❌  door_code_secret_id points at a Vault secret that
 *                            outlives the booking row unless explicitly deleted
 *   SMS opt-in phone     ❌  guidebook_guest_sms_optins.phone_e164
 *
 * The one deliberate exception is below: an opt-in row with opted_out_at set is
 * a TCPA suppression record. GDPR Art. 17(3)(b) — processing required to comply
 * with a legal obligation — is exactly what that is, and deleting it would let
 * the platform text a number that sent STOP. Those rows are retained and
 * reported back to the caller rather than silently skipped.
 */
const BOOKING_BATCH_SIZE = 200
/** 40,000 bookings for one guest in one org. A real request is 1–2 batches. */
const MAX_BOOKING_BATCHES = 200

interface StaleBooking {
  id:                  string
  door_code_secret_id: string | null
}

type ServiceClient = ReturnType<typeof createServiceClient>

export interface ErasureResult {
  success:             boolean
  bookingsAnonymized:  number
  /** Opt-in rows deleted (never opted out). */
  optInsDeleted?:      number
  /** Opt-in rows kept because they carry a STOP — see the note above. */
  optInsRetained?:     number
  error?:              string
}

/**
 * Deletes the Vault secrets behind a batch of bookings' door codes.
 *
 * A secret that is already gone must not block the anonymization of the row
 * referencing it, so a failed delete is logged and the loop continues — same
 * policy as the retention cron. The count returned is deletions ATTEMPTED, not
 * a success signal.
 */
async function deleteDoorCodeSecrets(
  supabase: ServiceClient,
  bookings: StaleBooking[],
  orgId:    string,
): Promise<void> {
  const secretIds = bookings
    .map((b) => b.door_code_secret_id)
    .filter((id): id is string => id !== null && id !== undefined)

  for (const secretId of secretIds) {
    const { error } = await supabase.rpc('delete_vault_secret', { p_secret_id: secretId })
    if (error) {
      // Never log the secret id itself — it is a handle to a door code.
      console.warn('[anonymizeGuestData] vault secret delete failed', {
        orgId, code: error.code, message: error.message,
      })
    }
  }
}

/**
 * Removes the guest's phone from the SMS opt-in table for these bookings,
 * preserving any row that carries a STOP.
 *
 * Returns { deleted, retained }. `retained` is counted rather than inferred, so
 * the UI can tell the operator that a suppression record survived the erasure
 * on purpose instead of leaving them to discover it.
 */
async function purgeSmsOptIns(
  supabase:   ServiceClient,
  bookingIds: string[],
  orgId:      string,
): Promise<{ deleted: number; retained: number } | { error: string }> {
  const retainedRes = await supabase
    .from('guidebook_guest_sms_optins')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .in('booking_id', bookingIds)
    .not('opted_out_at', 'is', null)

  if (retainedRes.error) return { error: retainedRes.error.message }

  const deletedRes = await supabase
    .from('guidebook_guest_sms_optins')
    .delete()
    .eq('org_id', orgId)
    .in('booking_id', bookingIds)
    .is('opted_out_at', null)
    .select('id')

  if (deletedRes.error) return { error: deletedRes.error.message }

  return { deleted: deletedRes.data?.length ?? 0, retained: retainedRes.count ?? 0 }
}

/**
 * Anonymize a guest's PII across all bookings in this org, matched by email.
 *
 * The booking row itself is retained — owner P&L and occupancy history have
 * ongoing value independent of guest identity — but every field on it that
 * identifies the guest is cleared, plus the Vault door code and the SMS opt-in
 * phone. See the note at the top of this file for the full surface.
 *
 * BATCHED, and the batching is load-bearing rather than cosmetic. The original
 * selected every matching booking in one unbounded `.select()`, which PostgREST
 * truncates at max_rows = 1000 with a 200 and no truncation signal — so a guest
 * with more history than that got a partial scrub reported as a completed
 * erasure. The loop is self-draining: the UPDATE clears `guest_email`, which is
 * the selection filter, so each pass returns the next slice and a retry after a
 * partial failure re-selects only what is left.
 *
 * ADMIN-ONLY. This runs with the service role, so RLS is not a backstop here:
 * the only thing standing between a caller and an irreversible, org-wide scrub
 * of guest PII is this gate. It used to be `requireOrgMember()`, which meant a
 * `viewer` or `crew` member could destroy booking data they cannot even read
 * through RLS. `requireOrgRole(['admin'])` also passes `owner` automatically
 * (see is_org_member) — matching the role model used everywhere else.
 */
/** SHA-256 — irreversible, suitable for an audit trail without exposing PII. */
function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(email).digest('hex')
}

/**
 * Records a scrub that stopped partway and returns the caller-safe result.
 *
 * Two things were wrong with returning `{ error: fetchErr.message }` directly.
 *
 * It handed a raw Postgres message to the browser — CLAUDE.md's error-handling
 * rule ("Never return raw error messages to the client"); those carry column
 * and constraint names and sometimes the offending value.
 *
 * And it was the only exit that skipped BOTH reportError and logAuditEvent. A
 * mid-batch failure could leave a real number of bookings already scrubbed —
 * irreversibly — with nothing in Sentry and nothing in the audit log. For an
 * Article 17 erasure the audit log is the compliance artifact; "some of it
 * happened and we have no record of which" is the worst available outcome.
 */
async function recordPartialErasure(params: {
  err:                unknown
  site:               string
  orgId:              string
  actorId:            string
  emailHash:          string
  bookingsAnonymized: number
  optInsDeleted:      number
  optInsRetained:     number
}): Promise<ErasureResult> {
  const { err, site, orgId, actorId, emailHash, bookingsAnonymized, optInsDeleted, optInsRetained } = params

  console.error(`[anonymizeGuestData] ${site}`, err)
  reportError(err, { site, orgId, extra: { bookings_anonymized: bookingsAnonymized } })

  if (bookingsAnonymized > 0) {
    await logAuditEvent({
      actorId,
      orgId,
      action:     'gdpr.data_erasure.completed',
      targetType: 'guest',
      metadata:   {
        email_hash:          emailHash,
        bookings_anonymized: bookingsAnonymized,
        optins_deleted:      optInsDeleted,
        optins_retained:     optInsRetained,
        request_type:        'erasure_article_17',
        partial:             true,
      },
    })
  }

  return {
    success: false,
    bookingsAnonymized,
    optInsDeleted,
    optInsRetained,
    error: bookingsAnonymized > 0
      ? `Erasure stopped partway — ${bookingsAnonymized} booking(s) were anonymized before it failed. Re-run to finish; already-scrubbed rows are skipped.`
      : 'Operation failed. Please try again.',
  }
}

export async function anonymizeGuestData(guestEmail: string): Promise<ErasureResult> {
  try {
    const { user, membership } = await requireOrgRole(['admin'])

    if (!guestEmail || !guestEmail.includes('@')) {
      return { success: false, bookingsAnonymized: 0, error: 'Invalid email address' }
    }

    const orgId    = membership.org_id
    const supabase = createServiceClient({ authorizedBy: membership })
    const normalizedEmail = guestEmail.toLowerCase().trim()

    let bookingsAnonymized = 0
    let optInsDeleted      = 0
    let optInsRetained     = 0

    const emailHash = hashEmail(normalizedEmail)
    const partial = (err: unknown, site: string) => recordPartialErasure({
      err, site, orgId, actorId: user.id, emailHash,
      bookingsAnonymized, optInsDeleted, optInsRetained,
    })

    for (let batch = 0; batch < MAX_BOOKING_BATCHES; batch++) {
      const { data: affected, error: fetchErr } = await supabase
        .from('bookings')
        .select('id, door_code_secret_id')
        .eq('org_id', orgId)
        .eq('guest_email', normalizedEmail)
        .order('id', { ascending: true })
        .limit(BOOKING_BATCH_SIZE)

      if (fetchErr) {
        return partial(fetchErr, 'serverAction.settings.privacy.anonymizeGuestData.fetch')
      }
      if (!affected?.length) break

      const rows = affected as StaleBooking[]
      const ids  = rows.map((b) => b.id)

      // Order matters: the Vault secret and the opt-in row are cleared BEFORE
      // the booking is scrubbed. door_code_secret_id is the only pointer to
      // the secret, so nulling it first would orphan the secret in Vault with
      // nothing left to find it by.
      await deleteDoorCodeSecrets(supabase, rows, orgId)

      const optIns = await purgeSmsOptIns(supabase, ids, orgId)
      if ('error' in optIns) {
        return partial(new Error(optIns.error), 'serverAction.settings.privacy.anonymizeGuestData.optIns')
      }
      optInsDeleted  += optIns.deleted
      optInsRetained += optIns.retained

      const { error: updateErr } = await supabase
        .from('bookings')
        .update({
          guest_name:              '[Deleted]',
          guest_email:             null,
          raw_ical_data:           null,
          door_code_secret_id:     null,
          guest_pii_anonymized_at: new Date().toISOString(),
        })
        .in('id', ids)
        .eq('org_id', orgId)

      if (updateErr) {
        return partial(updateErr, 'serverAction.settings.privacy.anonymizeGuestData.update')
      }

      bookingsAnonymized += ids.length
      if (ids.length < BOOKING_BATCH_SIZE) break
    }

    if (bookingsAnonymized === 0) {
      return { success: true, bookingsAnonymized: 0, optInsDeleted: 0, optInsRetained: 0 }
    }

    await logAuditEvent({
      actorId:    user.id,
      orgId,
      action:     'gdpr.data_erasure.completed',
      targetType: 'guest',
      metadata:   {
        email_hash:          emailHash,
        bookings_anonymized: bookingsAnonymized,
        optins_deleted:      optInsDeleted,
        optins_retained:     optInsRetained,
        request_type:        'erasure_article_17',
      },
    })

    return {
      success: true,
      bookingsAnonymized,
      optInsDeleted,
      optInsRetained,
    }
  } catch (err) {
    console.error('[anonymizeGuestData]', err)
    reportError(err, { site: 'serverAction.settings.privacy.anonymizeGuestData' })
    return { success: false, bookingsAnonymized: 0, error: 'Operation failed. Please try again.' }
  }
}
