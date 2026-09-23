'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { fetchAllRows } from '@/lib/inngest/paginate'
import {
  PMS_BACKFILL_COLUMNS,
  brandsAfter,
  brandsBefore,
  mappingSummary,
  planPmsChanges,
  type PmsChange,
  type PmsRow,
} from '@/lib/prospecting/pms-backfill'
import { PMS_CHUNK, PMS_MAPPINGS_SHOWN, type PmsPlanSummary } from './pms-constants'

type SessionClient = Awaited<ReturnType<typeof requirePlatformAdmin>>['supabase']

/**
 * Every account carrying a pms value.
 *
 * Paginated: PostgREST caps a single select at 1000 and says nothing when it
 * truncates. A short read here would silently leave the rows past the cap
 * un-normalized while reporting success.
 */
function loadRows(supabase: SessionClient): Promise<PmsRow[]> {
  return fetchAllRows<PmsRow>(
    (from, to) => supabase
      .from('prospect_accounts')
      .select(PMS_BACKFILL_COLUMNS)
      .not('pms', 'is', null)
      .order('id')
      .range(from, to),
    { label: 'admin.prospects.pms-backfill' },
  )
}

function summarize(rows: PmsRow[], changes: PmsChange[]): PmsPlanSummary {
  const mappings = mappingSummary(changes)
  return {
    considered:   rows.length,
    wouldChange:  changes.length,
    brandsBefore: brandsBefore(rows).length,
    brandsAfter:  brandsAfter(rows, changes).length,
    wouldClear:   changes.filter((c) => c.toPms === null).length,
    mappings:     mappings.slice(0, PMS_MAPPINGS_SHOWN),
    brands:       brandsAfter(rows, changes),
  }
}

/** What the backfill WOULD do. Reads the table, writes nothing. */
export async function planPmsNormalization(): Promise<{
  summary?: PmsPlanSummary
  error?:   string
}> {
  try {
    const { supabase } = await requirePlatformAdmin()
    const rows = await loadRows(supabase)
    return { summary: summarize(rows, planPmsChanges(rows)) }
  } catch (err) {
    console.error('[planPmsNormalization]', err)
    reportError(err, { site: 'serverAction.admin.prospects.planPmsNormalization' })
    return { error: 'Could not read the account list. Please try again.' }
  }
}

/**
 * Applies the backfill.
 *
 * The plan is RECOMPUTED here rather than round-tripped from the browser: a
 * plan that came back from a client is a set of row ids and column values this
 * action would have to re-validate in full before trusting, and the counts it
 * reports are then what actually happened rather than what a preview predicted.
 *
 * Safe to run twice — normalizePms is idempotent and evidence is never
 * appended to a note that already contains it, so a second run finds nothing
 * to change.
 */
export async function applyPmsNormalization(): Promise<{
  changed?: number
  error?:   string
}> {
  try {
    const { user, supabase } = await requirePlatformAdmin()
    const rows = await loadRows(supabase)
    const changes = planPmsChanges(rows)

    // One statement per chunk. This RPC assigns pms and pms_note directly
    // rather than COALESCEing, because clearing pms to NULL — for a cell
    // holding prose rather than a product — is a required outcome here.
    let changed = 0
    for (let at = 0; at < changes.length; at += PMS_CHUNK) {
      const batch = changes.slice(at, at + PMS_CHUNK).map((c) => ({
        id:       c.id,
        pms:      c.toPms,
        pms_note: c.toNote,
      }))
      const { data, error } = await supabase.rpc('prospect_apply_pms_normalization', {
        p_rows: batch,
      })
      if (error) {
        console.error('[applyPmsNormalization]', error)
        return { error: 'The backfill stopped partway through. Nothing after that point was written.' }
      }
      changed += data ?? 0
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_pms.normalized',
      targetType: 'prospect_accounts',
      targetId:   'batch',
      metadata:   { changed, considered: rows.length },
    })

    revalidatePath('/admin/prospects')
    return { changed }
  } catch (err) {
    console.error('[applyPmsNormalization]', err)
    reportError(err, { site: 'serverAction.admin.prospects.applyPmsNormalization' })
    return { error: 'The backfill failed. Please try again.' }
  }
}
