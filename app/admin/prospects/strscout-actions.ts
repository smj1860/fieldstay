'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { fetchAllRows } from '@/lib/inngest/paginate'
import {
  EXISTING_COLUMNS,
  type ExistingRow,
  type ImportPlan,
  type ProspectUpsert,
} from '@/lib/prospecting/import'
import {
  STR_PROSPECT_COLUMNS,
  planStrProspectSync,
  toProspectUpsert,
  type StrProspectRow,
} from '@/lib/prospecting/str-prospects'
import { STRSCOUT_CHUNK, type StrscoutPlanSummary } from './strscout-constants'

/**
 * Two clients, deliberately.
 *
 * str_prospects is service-role-only: RLS is on with ZERO policies and
 * `authenticated` holds no grant at all, so the session client cannot read it
 * — every query comes back "permission denied for table". The bypass is the
 * only way in, and requirePlatformAdmin() is what earns it.
 *
 * prospect_accounts is NOT read or written that way. It has real admin
 * policies, so it goes through the session client and keeps RLS as a
 * backstop; the bypass stays confined to the one table that needs it. That is
 * also what lets the writes use prospect_apply_import_updates(), which is
 * SECURITY INVOKER and checks is_platform_staff_admin() — a service-role
 * caller has no auth.uid() and would be refused by its own gate.
 */
async function clients() {
  const { user, supabase } = await requirePlatformAdmin()
  return { user, session: supabase, scraper: createServiceClient({ platformAdmin: { id: user.id } }) }
}

type Supabase = Awaited<ReturnType<typeof clients>>['scraper']
type SessionClient = Awaited<ReturnType<typeof clients>>['session']

/**
 * The scraper rows that qualify, mapped into the funnel's shape.
 *
 * Membership comes from str_prospects_icp — the view already defines the
 * FieldStay ICP, and duplicating its WHERE clause here would be a second copy
 * of that rule to drift. The base table is read for the columns because the
 * view does not expose `domain`.
 */
async function loadScrapedRows(
  supabase: Supabase,
  sizedOnly: boolean,
): Promise<ProspectUpsert[]> {
  // A view's columns are nullable to postgrest-js even when the table's are
  // not, so the key is narrowed here rather than asserted.
  const icp = await fetchAllRows<{ dedupe_key: string | null }>(
    (from, to) => supabase
      .from('str_prospects_icp')
      .select('dedupe_key')
      .order('dedupe_key')
      .range(from, to),
    { label: 'admin.prospects.strscout.icp' },
  )

  const keys = icp
    .map((r) => r.dedupe_key)
    .filter((k): k is string => k !== null)
  if (keys.length === 0) return []

  const rows: StrProspectRow[] = []
  for (let at = 0; at < keys.length; at += STRSCOUT_CHUNK) {
    // .limit() as well as the key slice: one row comes back per key, so the
    // slice already bounds this at STRSCOUT_CHUNK — but `.in()` is not an
    // equality filter, so nothing structural said so, and an unbounded
    // select is silently truncated at PostgREST's max_rows with a 200.
    const { data, error } = await supabase
      .from('str_prospects')
      .select(STR_PROSPECT_COLUMNS)
      .in('dedupe_key', keys.slice(at, at + STRSCOUT_CHUNK))
      .limit(STRSCOUT_CHUNK)
    if (error) throw new Error(`str_prospects: ${error.message}`)
    rows.push(...((data ?? []) as unknown as StrProspectRow[]))
  }

  const usable = sizedOnly ? rows.filter((r) => (r.property_count ?? 0) > 0) : rows
  return usable
    .map(toProspectUpsert)
    .filter((r): r is ProspectUpsert => r !== null)
}

function loadExisting(supabase: SessionClient): Promise<ExistingRow[]> {
  // Paginated: PostgREST caps a single select at 1000 and says nothing when it
  // truncates. A short index here is worse than none — every account it misses
  // becomes a duplicate insert.
  return fetchAllRows<ExistingRow>(
    (from, to) => supabase
      .from('prospect_accounts')
      .select(EXISTING_COLUMNS)
      .order('id')
      .range(from, to),
    { label: 'admin.prospects.strscout.existing' },
  )
}

async function buildSyncPlan(
  scraper: Supabase,
  session: SessionClient,
  sizedOnly: boolean,
): Promise<{ plan: ImportPlan; considered: number }> {
  const scraped = await loadScrapedRows(scraper, sizedOnly)
  const plan = planStrProspectSync(scraped, await loadExisting(session))
  return { plan, considered: scraped.length }
}

type PatchValue = string | number | null

/**
 * The patch as the RPC's jsonb argument.
 *
 * Scalars only. Every value planStrProspectSync produces is one, so anything
 * else did not come from the planner and has no business in a column — and
 * narrowing here is what makes the payload Json-typed without a cast.
 */
function jsonPatch(patch: Record<string, unknown>): Record<string, PatchValue> {
  const clean: Record<string, PatchValue> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || typeof value === 'string' || typeof value === 'number') {
      clean[key] = value
    }
  }
  return clean
}

function summarize(plan: ImportPlan, considered: number): StrscoutPlanSummary {
  return {
    considered,
    wouldAdd:       plan.inserts.length,
    wouldFill:      plan.updates.length,
    untouched:      plan.untouched,
    droppedDomains: plan.droppedDomains,
    fields:         Object.entries(plan.fieldCounts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([column, count]) => ({ column, count })),
  }
}

/** What the sync WOULD do. Reads both tables, writes nothing. */
export async function planStrscoutSync(
  sizedOnly: boolean,
): Promise<{ summary?: StrscoutPlanSummary; error?: string }> {
  try {
    const { scraper, session } = await clients()
    const { plan, considered } = await buildSyncPlan(scraper, session, sizedOnly)
    return { summary: summarize(plan, considered) }
  } catch (err) {
    console.error('[planStrscoutSync]', err)
    reportError(err, { site: 'serverAction.admin.prospects.planStrscoutSync' })
    return { error: 'Could not read the scraper list. Please try again.' }
  }
}

/**
 * Applies the sync.
 *
 * The plan is RECOMPUTED here rather than round-tripped from the browser: a
 * plan that came back from a client is a set of row ids and column values this
 * action would have to re-validate in full before trusting, and recomputing it
 * is both cheaper and impossible to tamper with. It also means the counts
 * reported are what actually happened, not what a preview predicted before
 * the scraper's next run changed the answer.
 */
export async function applyStrscoutSync(
  sizedOnly: boolean,
): Promise<{ added?: number; filled?: number; error?: string }> {
  try {
    const { user, scraper, session } = await clients()
    const { plan } = await buildSyncPlan(scraper, session, sizedOnly)

    // One statement per chunk, not one per row: each patch touches a
    // DIFFERENT set of columns, so there is no .in('id', ids) form of this
    // write. The RPC COALESCEs every column against its current value, which
    // is exactly the fill-only contract — a patch that omits a column leaves
    // it alone — and its SET list is the second, structural enforcement that
    // no status, note or contact name can be written here.
    let filled = 0
    for (let at = 0; at < plan.updates.length; at += STRSCOUT_CHUNK) {
      const batch = plan.updates
        .slice(at, at + STRSCOUT_CHUNK)
        .map(({ id, patch }) => ({ id, patch: jsonPatch(patch) }))
      const { data, error } = await session.rpc('prospect_apply_import_updates', {
        p_rows: batch,
      })
      if (error) {
        console.error('[applyStrscoutSync] update', error)
        return { error: 'The sync stopped partway through. Nothing after that point was written.' }
      }
      filled += data ?? 0
    }

    let added = 0
    for (let at = 0; at < plan.inserts.length; at += STRSCOUT_CHUNK) {
      const chunk = plan.inserts.slice(at, at + STRSCOUT_CHUNK)
      const { data, error } = await session
        .from('prospect_accounts')
        .insert(chunk)
        .select('id')
      if (error) {
        console.error('[applyStrscoutSync] insert', error)
        return { error: 'The sync stopped partway through. Nothing after that point was written.' }
      }
      added += (data ?? []).length
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_strscout.synced',
      targetType: 'prospect_accounts',
      targetId:   'batch',
      metadata:   { added, filled, sized_only: sizedOnly },
    })

    revalidatePath('/admin/prospects')
    return { added, filled }
  } catch (err) {
    console.error('[applyStrscoutSync]', err)
    reportError(err, { site: 'serverAction.admin.prospects.applyStrscoutSync' })
    return { error: 'The sync failed. Please try again.' }
  }
}
