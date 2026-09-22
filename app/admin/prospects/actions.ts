'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { inngest } from '@/lib/inngest/client'
import type { Database } from '@/types/database'
import {
  normalizeEmail,
  normalizePhone,
  normalizeWebsite,
} from '@/lib/prospecting/normalize'
import {
  PROSPECT_STATUSES,
  TOUCH_TYPES,
  TOUCH_LOGGING_STATUSES,
  CONTACT_COLUMNS_SELECT,
  CONTACT_EMAIL_STATUSES,
  MAX_CONTACTS_PER_PROSPECT,
  type ProspectStatus,
  type ProspectEditableFields,
  type ProspectTouch,
  type TouchType,
  type ProspectContactRow,
  type ProspectContactInput,
  PROMOTED_PRIMARY_COLUMNS,
  type PromotedPrimary,
} from './constants'

type ProspectUpdate = Database['public']['Tables']['prospect_accounts']['Update']

/**
 * Fields the table lets you edit inline. Everything else on the row
 * (scores, track, bucket) is written by the offline scorer — editing those
 * here would be overwritten on the next import, so they stay read-only.
 */
const EDITABLE_TEXT_FIELDS = [
  'company', 'domain', 'website', 'city', 'state', 'market',
  'pms', 'pms_note', 'contact_name', 'contact_title', 'email', 'phone',
  'linkedin_url', 'status_note', 'notes',
] as const

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function isStatus(value: unknown): value is ProspectStatus {
  return typeof value === 'string' && (PROSPECT_STATUSES as readonly string[]).includes(value)
}

/**
 * A status change is the one edit that means something happened in the world,
 * so the statuses below stamp last_touch_at. 'replied' and 'meeting_set' do
 * NOT: those record what the PROSPECT did, and overwriting last_touch_at with
 * their reply would hide how long it has been since we reached out — which is
 * the number the follow-up queue is sorted on.
 */
const TOUCH_STATUSES: ReadonlySet<string> = new Set([
  'emailed', 'called', 'texted', 'visited_no_contact',
])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

type TouchInsert = Database['public']['Tables']['prospect_touches']['Insert']

/**
 * One batched insert rather than one per prospect — the same N+1 concern
 * logAuditEvents() exists to avoid, here for bulkSetStatus's multi-id case.
 * Never throws: a touch row failing to write must not fail the status
 * update it is logging, so a failure is reported and swallowed.
 */
async function insertTouches(
  supabase: Awaited<ReturnType<typeof requirePlatformAdmin>>['supabase'],
  actorId: string,
  entries: readonly { prospectId: string; touchType: TouchType; note?: string | null }[],
): Promise<void> {
  if (entries.length === 0) return
  const rows: TouchInsert[] = entries.map((e) => ({
    prospect_id: e.prospectId,
    touch_type:  e.touchType,
    note:        e.note ?? null,
    actor_id:    actorId,
  }))
  const { error } = await supabase.from('prospect_touches').insert(rows)
  if (error) {
    console.error('[insertTouches]', error)
    reportError(error, { site: 'serverAction.admin.prospects.insertTouches' })
  }
}

/**
 * Turns the client's patch into a column payload, or names why it is invalid.
 * Separate from updateProspect so the validation branches don't sit inside the
 * same function as the query, the audit write and the error handling.
 */
function buildUpdate(
  patch: Partial<ProspectEditableFields>,
): { update: ProspectUpdate } | { error: string } {
  const update: ProspectUpdate = {}

  // Object.assign rather than `update[field] = …`: `field` is a union of
  // keys, and TypeScript will not narrow a write through one.
  for (const field of EDITABLE_TEXT_FIELDS) {
    if (field in patch) Object.assign(update, { [field]: cleanText(patch[field]) })
  }

  if ('company' in update && update.company === null) {
    return { error: 'Company name is required.' }
  }

  if ('status' in patch) {
    if (!isStatus(patch.status)) return { error: 'Unknown status.' }
    update.status = patch.status
    if (TOUCH_STATUSES.has(patch.status)) update.last_touch_at = new Date().toISOString()
  }

  if ('next_action_at' in patch) {
    const raw = cleanText(patch.next_action_at)
    // <input type="date"> gives YYYY-MM-DD or ''. Anything else is a bug or a
    // hand-edited payload; reject rather than let Postgres guess.
    if (raw !== null && !ISO_DATE.test(raw)) return { error: 'Next action must be a date.' }
    update.next_action_at = raw
  }

  return { update }
}

export async function updateProspect(
  id: string,
  patch: Partial<ProspectEditableFields>,
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const built = buildUpdate(patch)
    if ('error' in built) return { error: built.error }
    const { update } = built
    if (Object.keys(update).length === 0) return {}

    const { error } = await supabase
      .from('prospect_accounts')
      .update(update)
      .eq('id', id)

    if (error) {
      // 23505 is the one-row-per-domain unique index. Say which constraint
      // tripped — "operation failed" on a duplicate domain sends you looking
      // in the wrong place.
      if (error.code === '23505') {
        return { error: 'Another account already has that domain.' }
      }
      console.error('[updateProspect]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    if (update.status !== undefined && TOUCH_LOGGING_STATUSES.has(update.status as ProspectStatus)) {
      await insertTouches(supabase, user.id, [
        { prospectId: id, touchType: update.status as TouchType },
      ])
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_account.updated',
      targetType: 'prospect_accounts',
      targetId:   id,
      metadata:   { fields: Object.keys(update) },
    })

    revalidatePath('/admin/prospects')
    return {}
  } catch (err) {
    console.error('[updateProspect]', err)
    reportError(err, { site: 'serverAction.admin.prospects.updateProspect' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function createProspect(
  input: { company: string; domain?: string; city?: string; state?: string },
): Promise<{ id?: string; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const company = cleanText(input.company)
    if (!company) return { error: 'Company name is required.' }

    const { data, error } = await supabase
      .from('prospect_accounts')
      .insert({
        company,
        domain: cleanText(input.domain),
        city:   cleanText(input.city),
        state:  cleanText(input.state),
        status: 'new',
        source: 'manual',
      })
      .select('id')
      .single()

    if (error || !data) {
      if (error?.code === '23505') {
        return { error: 'An account with that domain already exists.' }
      }
      console.error('[createProspect]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_account.created',
      targetType: 'prospect_accounts',
      targetId:   data.id,
      metadata:   { company },
    })

    revalidatePath('/admin/prospects')
    return { id: data.id }
  } catch (err) {
    console.error('[createProspect]', err)
    reportError(err, { site: 'serverAction.admin.prospects.createProspect' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/**
 * Sets the same status on a set of rows — the "I just sent all five of these"
 * case, which is otherwise five round trips and five chances to miss one.
 */
export async function bulkSetStatus(
  ids: string[],
  status: ProspectStatus,
): Promise<{ updated?: number; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    if (ids.length === 0) return { updated: 0 }
    if (!isStatus(status)) return { error: 'Unknown status.' }

    const update: ProspectUpdate = { status }
    if (TOUCH_STATUSES.has(status)) update.last_touch_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('prospect_accounts')
      .update(update)
      .in('id', ids)
      .select('id')

    if (error) {
      console.error('[bulkSetStatus]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    const updatedIds = (data ?? []).map((r) => r.id)

    if (TOUCH_LOGGING_STATUSES.has(status)) {
      await insertTouches(
        supabase,
        user.id,
        updatedIds.map((prospectId) => ({ prospectId, touchType: status as TouchType })),
      )
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_account.bulk_status',
      targetType: 'prospect_accounts',
      targetId:   ids[0],
      metadata:   { status, count: updatedIds.length },
    })

    revalidatePath('/admin/prospects')
    return { updated: updatedIds.length }
  } catch (err) {
    console.error('[bulkSetStatus]', err)
    reportError(err, { site: 'serverAction.admin.prospects.bulkSetStatus' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/**
 * Logs one prospect_touches row. Used directly for a manual "log a call/
 * note" entry, and internally by updateProspect/bulkSetStatus when a status
 * change represents an actual outreach event (see TOUCH_LOGGING_STATUSES).
 */
export async function logProspectTouch(
  prospectId: string,
  touchType: TouchType,
  note?: string,
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    if (!(TOUCH_TYPES as readonly string[]).includes(touchType)) {
      return { error: 'Unknown touch type.' }
    }

    const { error } = await supabase.from('prospect_touches').insert({
      prospect_id: prospectId,
      touch_type:  touchType,
      note:        cleanText(note),
      actor_id:    user.id,
    })

    if (error) {
      console.error('[logProspectTouch]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    revalidatePath('/admin/prospects')
    return {}
  } catch (err) {
    console.error('[logProspectTouch]', err)
    reportError(err, { site: 'serverAction.admin.prospects.logProspectTouch' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/** Newest-first touch history for one prospect — loaded lazily when its row expands. */
export async function listProspectTouches(
  prospectId: string,
): Promise<{ touches?: ProspectTouch[]; error?: string }> {
  try {
    const { supabase } = await requirePlatformAdmin()

    const { data, error } = await supabase
      .from('prospect_touches')
      .select('id, prospect_id, touch_type, note, occurred_at')
      .eq('prospect_id', prospectId)
      .order('occurred_at', { ascending: false })
      .limit(50)

    if (error) {
      console.error('[listProspectTouches]', error)
      return { error: 'Could not load history.' }
    }

    return { touches: (data ?? []) as ProspectTouch[] }
  } catch (err) {
    console.error('[listProspectTouches]', err)
    reportError(err, { site: 'serverAction.admin.prospects.listProspectTouches' })
    return { error: 'Could not load history.' }
  }
}

const MAX_CRAWL_BATCH = 100
const DEFAULT_CRAWL_BATCH = 25

/**
 * Queues an admin-triggered re-crawl of comparent.com for up to `limit`
 * accounts (oldest-crawled-first — see lib/inngest/functions/prospecting-
 * crawl.ts). Fire-and-forget from the caller's point of view: the dispatcher
 * runs in the background and each row's last_crawled_at/crawl_status updates
 * as it completes, which is why this returns nothing to poll — the admin
 * page just shows the refreshed values on its next load.
 */
export async function triggerProspectCrawl(
  limit: number = DEFAULT_CRAWL_BATCH,
): Promise<{ error?: string }> {
  try {
    const { user } = await requirePlatformAdmin()

    const bounded = Math.max(1, Math.min(Math.trunc(limit) || DEFAULT_CRAWL_BATCH, MAX_CRAWL_BATCH))

    await inngest.send({
      name: 'prospecting/crawl.requested',
      data: { requested_by: user.id, limit: bounded },
    })

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_account.crawl_triggered',
      targetType: 'prospect_accounts',
      targetId:   'batch',
      metadata:   { limit: bounded },
    })

    return {}
  } catch (err) {
    console.error('[triggerProspectCrawl]', err)
    reportError(err, { site: 'serverAction.admin.prospects.triggerProspectCrawl' })
    return { error: 'Could not start the crawl. Please try again.' }
  }
}

// ── contacts ─────────────────────────────────────────────────────────────────
//
// The PRIMARY contact is not here. It lives on the account row and is edited
// through updateProspect above, because the contact-channel filter, the CSV
// export, the crawl and the email_is_generic generated column all read those
// columns directly — see 20260922140000_prospect_contacts.sql. These actions
// manage the ADDITIONAL people, and promoteProspectContact swaps one into the
// primary slot.

/** Newest-last contact list for one prospect — loaded when its row expands. */
export async function listProspectContacts(
  prospectId: string,
): Promise<{ contacts?: ProspectContactRow[]; error?: string }> {
  try {
    const { supabase } = await requirePlatformAdmin()

    const { data, error } = await supabase
      .from('prospect_contacts')
      .select(CONTACT_COLUMNS_SELECT)
      .eq('prospect_id', prospectId)
      .order('created_at')
      .limit(MAX_CONTACTS_PER_PROSPECT)

    if (error) {
      console.error('[listProspectContacts]', error)
      return { error: 'Could not load contacts.' }
    }

    return { contacts: (data ?? []) as ProspectContactRow[] }
  } catch (err) {
    console.error('[listProspectContacts]', err)
    reportError(err, { site: 'serverAction.admin.prospects.listProspectContacts' })
    return { error: 'Could not load contacts.' }
  }
}

type ContactPayload = Database['public']['Tables']['prospect_contacts']['Insert']

/**
 * Normalizes the form's fields, or names why they cannot be used.
 *
 * An email that does not parse is REFUSED rather than stored: the column
 * feeds a lower(email) unique index and, once promoted, the account's
 * email_is_generic. A phone that does not parse is KEPT as typed — "call the
 * office, ask for Dana" is the only way to reach some of these companies.
 */
function buildContact(
  input: ProspectContactInput,
): { payload: Omit<ContactPayload, 'prospect_id'> } | { error: string } {
  const email = cleanText(input.email)
  const normalizedEmail = email === null ? null : normalizeEmail(email)
  if (email !== null && normalizedEmail === null) {
    return { error: 'That email address is not valid.' }
  }

  const phone = cleanText(input.phone)
  const parsedPhone = phone === null ? null : normalizePhone(phone)

  const linkedin = cleanText(input.linkedin_url)
  const normalizedLinkedin = linkedin === null ? null : normalizeWebsite(linkedin)
  if (linkedin !== null && normalizedLinkedin === null) {
    return { error: 'That LinkedIn URL is not a usable web address.' }
  }

  const fullName = cleanText(input.full_name)

  // Mirrors prospect_contacts_has_identity. Checked here too so the message
  // says what to do rather than surfacing a constraint name.
  if (fullName === null && normalizedEmail === null && parsedPhone === null) {
    return { error: 'A contact needs at least a name, an email or a phone number.' }
  }

  const status = input.email_status
  if (status !== undefined && !(CONTACT_EMAIL_STATUSES as readonly string[]).includes(status)) {
    return { error: 'Unknown email status.' }
  }

  return {
    payload: {
      full_name:    fullName,
      title:        cleanText(input.title),
      email:        normalizedEmail,
      phone:        parsedPhone === null ? null : (parsedPhone.e164 ?? parsedPhone.raw),
      linkedin_url: normalizedLinkedin,
      email_status: status ?? 'unknown',
      notes:        cleanText(input.notes),
      // email_key is GENERATED ALWAYS and must never be named in a payload:
      // Postgres rejects the WHOLE statement with 428C9, not just that column.
    },
  }
}

/** Creates a contact, or updates it when the input carries an id. */
export async function saveProspectContact(
  prospectId: string,
  input: ProspectContactInput,
): Promise<{ id?: string; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const built = buildContact(input)
    if ('error' in built) return { error: built.error }

    const query = input.id === undefined
      ? supabase
          .from('prospect_contacts')
          .insert({ ...built.payload, prospect_id: prospectId })
      : supabase
          .from('prospect_contacts')
          .update(built.payload)
          .eq('id', input.id)
          .eq('prospect_id', prospectId)

    const { data, error } = await query.select('id').single()

    if (error || !data) {
      if (error?.code === '23505') {
        return { error: 'This company already has a contact with that email.' }
      }
      console.error('[saveProspectContact]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_contact.saved',
      targetType: 'prospect_contacts',
      targetId:   data.id,
      // No names, addresses or numbers: audit rows are read during an
      // incident, not a second home for contact details.
      metadata:   { prospect_id: prospectId, created: input.id === undefined },
    })

    revalidatePath('/admin/prospects')
    return { id: data.id }
  } catch (err) {
    console.error('[saveProspectContact]', err)
    reportError(err, { site: 'serverAction.admin.prospects.saveProspectContact' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deleteProspectContact(
  contactId: string,
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { error } = await supabase
      .from('prospect_contacts')
      .delete()
      .eq('id', contactId)

    if (error) {
      console.error('[deleteProspectContact]', error)
      return { error: 'Could not remove that contact.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_contact.deleted',
      targetType: 'prospect_contacts',
      targetId:   contactId,
    })

    revalidatePath('/admin/prospects')
    return {}
  } catch (err) {
    console.error('[deleteProspectContact]', err)
    reportError(err, { site: 'serverAction.admin.prospects.deleteProspectContact' })
    return { error: 'Could not remove that contact.' }
  }
}

/**
 * Swaps a contact into the account's primary slot.
 *
 * The swap itself is one RPC under a row lock: done as two client-side
 * writes, a failure between them would leave the person recorded twice or
 * not at all.
 */
export async function promoteProspectContact(
  contactId: string,
  prospectId: string,
): Promise<{ primary?: PromotedPrimary; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { error } = await supabase.rpc('prospect_promote_contact', {
      p_contact_id: contactId,
    })

    if (error) {
      if (error.code === '23505') {
        return { error: 'The contact being replaced has the same email as another contact here.' }
      }
      console.error('[promoteProspectContact]', error)
      return { error: 'Could not make that contact primary.' }
    }

    // Read the row back rather than deriving it client-side: the swap is
    // bidirectional and email_is_generic is computed by the database, so the
    // only honest source for what the account now holds is the account.
    const { data: primary, error: readError } = await supabase
      .from('prospect_accounts')
      .select(PROMOTED_PRIMARY_COLUMNS)
      .eq('id', prospectId)
      .single()

    if (readError || !primary) {
      console.error('[promoteProspectContact] read-back', readError)
      // The swap DID happen; only the refresh failed. Saying it failed would
      // invite a second promote, which would swap it straight back.
      return {}
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_contact.promoted',
      targetType: 'prospect_contacts',
      targetId:   contactId,
    })

    revalidatePath('/admin/prospects')
    return { primary: primary as PromotedPrimary }
  } catch (err) {
    console.error('[promoteProspectContact]', err)
    reportError(err, { site: 'serverAction.admin.prospects.promoteProspectContact' })
    return { error: 'Could not make that contact primary.' }
  }
}
