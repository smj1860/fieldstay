import type { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { IN_CLAUSE_CHUNK_SIZE } from '@/lib/inngest/chunk'
import type { CrewRole } from '@/types/database'

/**
 * Keep a PM's crew-role edit through a provider staff sync.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * Both provider staff syncs write crew_members with
 * `.upsert(..., { onConflict: 'org_id,external_id,external_source' })`, and
 * PostgREST renders that as ON CONFLICT DO UPDATE SET one assignment per column
 * present in the payload. `role` is in both payloads — inferred from the
 * provider's own labels — so a role the PM chose in crew-manage was overwritten
 * by the next nightly cron. Silently: the edit saves, the UI shows it, and by
 * morning it is the inferred value again.
 *
 * Hostex hit this and fixed it locally on 2026-08-17. Hospitable has the
 * identical payload and never got the fix, so it was still live there on
 * 2026-08-27 against an org with six synced crew. That is the reason this now
 * lives in one shared place instead of two: the first copy did not generalise
 * itself, and the second provider paid for it.
 *
 * ── The stored value wins, full stop ────────────────────────────────────────
 *
 * `has`, not truthiness, and no carve-out for 'general'. The Hostex fix
 * originally preserved every role EXCEPT 'general', reasoning that 'general'
 * means "not yet known" so inference could still improve it. That re-opened the
 * bug for exactly the population it was written for: 'general' is where Hostex
 * receptionists and operators land by default AND a role a PM can deliberately
 * choose, and nothing on the row distinguishes "the PM reviewed this person and
 * left them General" from "we guessed General last night". Recovering that
 * distinction needs a column recording whether the role was inferred or chosen.
 *
 * The accepted cost: a staff member whose role was inferred at first sync keeps
 * that inference until someone edits it, even if the provider's labels later
 * get better.
 *
 * ── Reading it back at scale ─────────────────────────────────────────────────
 *
 * `.in('external_id', externalIds).limit(externalIds.length)` used to be one
 * call for the whole batch. `.limit()` only shrinks a result that already
 * arrived — it cannot rescue rows PostgREST's `max_rows = 1000` had already
 * dropped from the response before `.limit()` ever saw it, so a sync with
 * more than 1000 staff in one payload silently stopped preserving roles past
 * the thousandth. externalIds is now walked in `IN_CLAUSE_CHUNK_SIZE`-sized
 * chunks (a classic bounded `for (let i = 0; …)` chunking loop, not a
 * per-row one — see n-plus-one-loops.test.ts's own note on this shape), and
 * each chunk is read through `fetchAllRows` rather than a bare `.limit()`:
 * the upsert's own conflict target (org_id, external_id, external_source)
 * means one external_id maps to exactly one row today, but paginating
 * defensively rather than trusting that costs nothing and matches this
 * codebase's standing rule against unpaginated platform reads.
 *
 * One batch of reads per chunk keyed by external_id — never a lookup per
 * staff member (unit/guardrails/n-plus-one-loops.test.ts).
 */
export async function preserveManualCrewRoles<
  T extends { external_id: string; role: CrewRole },
>(
  supabase: ReturnType<typeof createServiceClient>,
  orgId:    string,
  provider: string,
  rows:     T[],
  site:     string,
): Promise<T[]> {
  if (!rows.length) return rows

  const externalIds = rows.map((r) => r.external_id)
  const existing: { external_id: string | null; role: CrewRole }[] = []

  for (let i = 0; i < externalIds.length; i += IN_CLAUSE_CHUNK_SIZE) {
    const chunk = externalIds.slice(i, i + IN_CLAUSE_CHUNK_SIZE)

    // A failed read must not fall through to overwriting every role: that is
    // the exact behaviour being fixed, and returning `rows` unchanged on
    // error would reintroduce it on any transient failure. fetchAllRows
    // throws on a query error, and the enclosing step retries.
    const page = await fetchAllRows<{ external_id: string | null; role: CrewRole }>(
      (from, to) => supabase
        .from('crew_members')
        .select('external_id, role')
        .eq('org_id', orgId)
        .eq('external_source', provider)
        .in('external_id', chunk)
        .order('external_id')
        .range(from, to),
      { label: site },
    )
    existing.push(...page)
  }

  const roleByExternalId = new Map(
    existing
      .filter((row): row is { external_id: string; role: CrewRole } => row.external_id !== null)
      .map((row) => [row.external_id, row.role]),
  )

  return rows.map((row) =>
    roleByExternalId.has(row.external_id)
      ? { ...row, role: roleByExternalId.get(row.external_id)! }
      : row,
  )
}
