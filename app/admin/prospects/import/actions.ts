'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { fetchAllRows } from '@/lib/inngest/paginate'
import {
  EXISTING_COLUMNS,
  WRITABLE_COLUMNS,
  type ExistingRow,
} from '@/lib/prospecting/import'
import type { Database, ProspectImport } from '@/types/database'
import {
  IMPORT_LIST_COLUMNS,
  IMPORT_LIST_LIMIT,
  MAX_CHUNK,
  type ApplyChunk,
} from './constants'

type ProspectInsert = Database['public']['Tables']['prospect_accounts']['Insert']

/**
 * The identity index the wizard resolves its file against.
 *
 * ── WHY THE PLAN IS COMPUTED IN THE BROWSER ─────────────────────────────────
 *
 * Matching needs every existing row at once: keysOf gives each row several
 * identity keys and a file row is resolved against all of them, so there is
 * no per-row query that answers it. Sending the whole index once and letting
 * lib/prospecting/import.ts run there is what lets the wizard and
 * scripts/import-prospects.ts share one buildPlan() — and a second matcher
 * would be a second chance to reintroduce the duplicate rows this list
 * already has 51 of.
 *
 * It does not widen anything: only a platform admin reaches this page, the
 * admin list page already ships every column of all 3,400 rows to the
 * browser, and applyImportChunk below re-validates every column name it is
 * handed rather than trusting the plan it gets back.
 */
export async function loadProspectIdentityIndex(): Promise<{
  rows?:  ExistingRow[]
  error?: string
}> {
  try {
    const { supabase } = await requirePlatformAdmin()

    // Paginated: PostgREST caps a single select at 1000 rows and says
    // nothing when it truncates. A short index is worse than no index —
    // every row it is missing becomes a duplicate insert.
    const rows = await fetchAllRows<ExistingRow>(
      (from, to) => supabase
        .from('prospect_accounts')
        .select(EXISTING_COLUMNS)
        .order('id')
        .range(from, to),
      { label: 'admin.prospects.import.index' },
    )

    return { rows }
  } catch (err) {
    console.error('[loadProspectIdentityIndex]', err)
    reportError(err, { site: 'serverAction.admin.prospects.import.loadIndex' })
    return { error: 'Could not load the existing account list. Please try again.' }
  }
}

export async function startProspectImport(
  sourceName: string,
  rowCount: number,
  skippedCount: number,
): Promise<{ id?: string; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const name = sourceName.trim().slice(0, 300)
    if (name === '') return { error: 'The file needs a name.' }

    const { data, error } = await supabase
      .from('prospect_imports')
      .insert({
        source_name:   name,
        row_count:     Math.max(0, Math.trunc(rowCount)),
        skipped_count: Math.max(0, Math.trunc(skippedCount)),
        status:        'running',
        imported_by:   user.id,
      })
      .select('id')
      .single()

    if (error || !data) {
      console.error('[startProspectImport]', error)
      return { error: 'Could not start the import. Please try again.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_import.started',
      targetType: 'prospect_imports',
      targetId:   data.id,
      metadata:   { rows: rowCount, skipped: skippedCount },
    })

    return { id: data.id }
  } catch (err) {
    console.error('[startProspectImport]', err)
    reportError(err, { site: 'serverAction.admin.prospects.import.start' })
    return { error: 'Could not start the import. Please try again.' }
  }
}

/**
 * Drops every key the import is not allowed to write.
 *
 * The plan is computed in the browser (see loadProspectIdentityIndex), so
 * this is where the column allowlist is actually enforced. It is not about
 * distrusting the admin — they can already edit any of these rows by hand —
 * it is about the funnel columns: status, notes, next_action_at and
 * last_touch_at are a person's work, and no import may touch them however
 * the payload arrived.
 */
type PatchValue = string | number | null

function sanitize(patch: Record<string, unknown>): Record<string, PatchValue> {
  const clean: Record<string, PatchValue> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!WRITABLE_COLUMNS.includes(key)) continue
    // Scalars only. Every value a plan produces is one, so anything else is a
    // payload that did not come from buildPlan and has no business in a column.
    if (value === null || typeof value === 'string' || typeof value === 'number') {
      clean[key] = value
    }
  }
  return clean
}

/**
 * Applies one chunk of a plan built by lib/prospecting/import.ts.
 *
 * Returns counts rather than rows: the wizard only needs the progress bar and
 * the final tally, and the rows are already on its screen.
 */
export async function applyImportChunk(
  importId: string,
  chunk: ApplyChunk,
): Promise<{ created?: number; updated?: number; error?: string }> {
  try {
    const { supabase } = await requirePlatformAdmin()

    if (chunk.updates.length + chunk.inserts.length > MAX_CHUNK) {
      return { error: 'That batch is too large.' }
    }

    // One statement for the whole chunk. Each row updates a DIFFERENT set of
    // columns, so there is no .in('id', ids) form of this write, and issuing
    // them one at a time is ~3,000 round trips on a full master-sheet import.
    // The RPC COALESCEs every column against its current value, so a patch
    // that omits a column leaves it alone.
    const patches = chunk.updates
      .map(({ id, patch }) => ({ id, patch: sanitize(patch) }))
      .filter(({ patch }) => Object.keys(patch).length > 0)

    let updated = 0
    if (patches.length > 0) {
      const { data, error } = await supabase.rpc('prospect_apply_import_updates', {
        p_rows: patches,
      })
      if (error) {
        console.error('[applyImportChunk] update', error)
        return { error: 'The import failed partway through. Nothing after this point was written.' }
      }
      updated = data ?? 0
    }

    const inserts = chunk.inserts
      .map((row): Record<string, PatchValue> => ({ ...sanitize(row), import_id: importId }))
      .filter((row) => typeof row.company === 'string' && row.company !== '')

    let created = 0
    if (inserts.length > 0) {
      const { data, error } = await supabase
        .from('prospect_accounts')
        .insert(inserts as ProspectInsert[])
        .select('id')
      if (error) {
        console.error('[applyImportChunk] insert', error)
        return { error: 'The import failed partway through. Nothing after this point was written.' }
      }
      created = (data ?? []).length
    }

    return { created, updated }
  } catch (err) {
    console.error('[applyImportChunk]', err)
    reportError(err, { site: 'serverAction.admin.prospects.import.applyChunk' })
    return { error: 'The import failed partway through. Nothing after this point was written.' }
  }
}

export async function finishProspectImport(
  importId: string,
  counts: { created: number; updated: number },
  failure?: string,
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { error } = await supabase
      .from('prospect_imports')
      .update({
        status:        failure === undefined ? 'complete' : 'failed',
        error:         failure ?? null,
        created_count: Math.max(0, Math.trunc(counts.created)),
        updated_count: Math.max(0, Math.trunc(counts.updated)),
        completed_at:  new Date().toISOString(),
      })
      .eq('id', importId)

    if (error) {
      console.error('[finishProspectImport]', error)
      return { error: 'The rows were written but the import could not be closed out.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_import.finished',
      targetType: 'prospect_imports',
      targetId:   importId,
      metadata:   { ...counts, failed: failure !== undefined },
    })

    revalidatePath('/admin/prospects')
    revalidatePath('/admin/prospects/import')
    return {}
  } catch (err) {
    console.error('[finishProspectImport]', err)
    reportError(err, { site: 'serverAction.admin.prospects.import.finish' })
    return { error: 'The rows were written but the import could not be closed out.' }
  }
}

/**
 * Removes the accounts an import created that nobody has touched since.
 *
 * The decision of what "untouched" means lives in the RPC, not here: it is a
 * single DELETE ... WHERE NOT EXISTS under a row lock, so two undo clicks
 * cannot both pass the check and a row cannot be worked between the check
 * and the delete.
 */
export async function undoProspectImport(
  importId: string,
): Promise<{ deleted?: number; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { data, error } = await supabase.rpc('prospect_undo_import', {
      p_import_id: importId,
    })

    if (error) {
      console.error('[undoProspectImport]', error)
      return { error: 'Could not undo that import. Please try again.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.prospect_import.undone',
      targetType: 'prospect_imports',
      targetId:   importId,
      metadata:   { deleted: data ?? 0 },
    })

    revalidatePath('/admin/prospects')
    revalidatePath('/admin/prospects/import')
    return { deleted: data ?? 0 }
  } catch (err) {
    console.error('[undoProspectImport]', err)
    reportError(err, { site: 'serverAction.admin.prospects.import.undo' })
    return { error: 'Could not undo that import. Please try again.' }
  }
}

/** The 25 most recent import runs, newest first. */
export async function listProspectImports(): Promise<{
  imports?: ProspectImport[]
  error?:   string
}> {
  try {
    const { supabase } = await requirePlatformAdmin()

    const { data, error } = await supabase
      .from('prospect_imports')
      .select(IMPORT_LIST_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(IMPORT_LIST_LIMIT)

    if (error) {
      console.error('[listProspectImports]', error)
      return { error: 'Could not load the import history.' }
    }

    return { imports: (data ?? []) as ProspectImport[] }
  } catch (err) {
    console.error('[listProspectImports]', err)
    reportError(err, { site: 'serverAction.admin.prospects.import.list' })
    return { error: 'Could not load the import history.' }
  }
}
