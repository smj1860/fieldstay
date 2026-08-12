import { NextResponse }        from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents }      from '@/lib/audit'
import { dataExportLimiter, checkLimit } from '@/lib/rate-limit'
import { throwIfAnyQueryFailed, unwrapList, type PostgrestResult } from '@/lib/supabase/unwrap'

/**
 * Ceiling on rows of any one history series in a single export.
 *
 * This replaced a flat `.limit(500)` / `.limit(200)`, which is a different
 * thing wearing the same clothes. A `.limit()` silently drops everything past
 * it — and this is an Article 15 right-of-access response, where "all the
 * personal data we hold about you" quietly meaning "the most recent 500
 * events" is a compliance defect, not a performance tuning choice. Nothing in
 * the payload, the response or the logs said a word about it.
 *
 * So the reads page to completeness now, and this ceiling exists only to keep
 * an unbounded scan off a request thread. Crossing it is DISCLOSED — in the
 * payload, so the subject knows their export is partial, and in the log, so we
 * do too.
 *
 * Deliberately sized against the synchronous design. The scalability audit
 * (P2-14) proposed moving the whole export to an Inngest job writing to
 * Storage. That is the right answer once these numbers get large and the wrong
 * one today: it would make every export slower and add a table, a bucket, a
 * job and a polling UI to guard volumes no account is near. This ceiling keeps
 * that trade honest — while it holds, the synchronous build is provably small,
 * and `truncated` firing is the signal that it no longer does.
 */
const HISTORY_ROW_CEILING = 5_000

/** One page below PostgREST's own cap, so a page is never itself truncated. */
const PAGE = 500

/**
 * Pages a query to completeness OR to `HISTORY_ROW_CEILING`, and reports which.
 *
 * Deliberately not fetchAllRows(): that THROWS when it passes maxRows, which
 * is right for a cron (a scan that big is a bug) and wrong here (an export
 * that big is a person with a lot of history, and denying them the export
 * outright is the worst available outcome).
 */
async function fetchCapped<T>(
  page: (from: number, to: number) => PromiseLike<PostgrestResult<T[]>>,
  site: string,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []

  for (let from = 0; from <= HISTORY_ROW_CEILING; from += PAGE) {
    const res = await page(from, from + PAGE - 1)
    const batch = unwrapList(res, { site })
    rows.push(...batch)

    if (batch.length < PAGE) return { rows, truncated: false }          // ran out first
    if (rows.length > HISTORY_ROW_CEILING) {
      return { rows: rows.slice(0, HISTORY_ROW_CEILING), truncated: true }
    }
  }

  return { rows, truncated: true }
}

/**
 * GET /api/gdpr/export
 *
 * GDPR Article 15 / CCPA — right of access / data portability.
 * Returns all personal data held for the authenticated user as a
 * structured JSON download. Requires a valid auth session.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // L-2: authenticated but expensive — five service-role cross-org queries
  // returning ~700 rows per call, with nothing but the session between a
  // held-down refresh key and all of it. Abuse limiter → fails OPEN: a Redis
  // outage must not block a user exercising a GDPR Article 15 right.
  const rl = await checkLimit(dataExportLimiter, `gdpr-export:${user.id}`, {
    onError: 'allow',
    site:    'route.gdpr.export.GET',
  })
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Export limit reached. Please try again later.' },
      { status: 429 }
    )
  }

  // Service client — fetches across org boundaries for a complete personal data picture
  const admin = createServiceClient({ authenticatedUser: user })

  const [
    { data: profile, error: profileError },
    { data: memberships, error: membershipsError },
    { data: crewMember, error: crewMemberError },
    { data: pushSubs, error: pushSubsError },
  ] = await Promise.all([
    admin.from('profiles').select('id, full_name, avatar_url, created_at').eq('id', user.id).single(),
    // Bounded, both here and on push_subscriptions below: an export that
    // silently omits rows is exactly the "incomplete export shipped as
    // complete" the check below already guards against for query FAILURES.
    // A user is far below these bounds; the point is that truncation must not
    // be able to masquerade as the real answer.
    admin.from('organization_members').select('org_id, role, invite_accepted_at').eq('user_id', user.id).limit(500),
    admin.from('crew_members').select('id, name, role, reliability_score, capacity_score, created_at').eq('user_id', user.id).maybeSingle(),
    admin.from('push_subscriptions').select('endpoint, created_at').eq('user_id', user.id).limit(500),
  ])
  // A partial failure here must not silently ship an incomplete GDPR export
  // as though it were complete — fail the request instead.
  throwIfAnyQueryFailed(
    { site: 'route.gdpr.export', extra: { userId: user.id } },
    profileError, membershipsError, crewMemberError, pushSubsError,
  )

  // Paged, not `.limit(500)`. `created_at` is not unique, so it gets an `id`
  // tiebreak — without a total ordering, keyset-free `.range()` paging can
  // repeat or skip rows across page boundaries.
  const audit = await fetchCapped<{ action: string; target_type: string | null; target_id: string | null; created_at: string }>(
    (from, to) => admin
      .from('audit_events')
      .select('action, target_type, target_id, created_at')
      .eq('actor_id', user.id)
      .order('created_at', { ascending: false })
      .order('id',         { ascending: true })
      .range(from, to),
    'route.gdpr.export.audit_events',
  )

  let assignments = { rows: [] as { turnover_id: string; assigned_at: string }[], truncated: false }
  if (crewMember) {
    assignments = await fetchCapped<{ turnover_id: string; assigned_at: string }>(
      (from, to) => admin
        .from('turnover_assignments')
        .select('turnover_id, assigned_at')
        .eq('crew_member_id', crewMember.id)
        .order('assigned_at',  { ascending: false })
        .order('turnover_id',  { ascending: true })   // tiebreak, as above
        .range(from, to),
      'route.gdpr.export.crew_assignments',
    )
  }

  const orgIds = (memberships ?? []).map((m) => m.org_id)

  // Log once per org the user belongs to — a single event scoped to only
  // the first org would silently drop the export record for a multi-org
  // user's other orgs. Skip entirely for a zero-org user rather than log
  // with an undefined orgId.
  if (orgIds.length > 0) {
    await logAuditEvents(
      orgIds.map((orgId) => ({
        orgId,
        actorId:    user.id,
        action:     'gdpr.data_export.requested' as const,
        targetType: 'user',
        targetId:   user.id,
      }))
    )
  }

  const payload = {
    exported_at:              new Date().toISOString(),
    account: {
      id:         user.id,
      email:      user.email,
      created_at: user.created_at,
      profile,
    },
    organization_memberships: memberships ?? [],
    crew_profile:             crewMember ?? null,
    crew_assignments:         assignments.rows,
    push_subscriptions:       (pushSubs ?? []).map(s => ({ endpoint: s.endpoint, created_at: s.created_at })),
    audit_trail:              audit.rows,

    // Present ALWAYS, not only when something was cut. An Article 15 response
    // has to be honest about its own completeness, and a field that appears
    // only on the unhappy path is one nobody builds against — a consumer that
    // has never seen it will not check for it.
    completeness: {
      complete: !audit.truncated && !assignments.truncated,
      row_ceiling_per_series: HISTORY_ROW_CEILING,
      truncated: {
        audit_trail:      audit.truncated,
        crew_assignments: assignments.truncated,
      },
      note: audit.truncated || assignments.truncated
        ? 'One or more history series exceeded the per-series row ceiling and was cut to the most recent entries. ' +
          'Contact support@fieldstay.app for the full record.'
        : null,
    },
  }

  // No silent caps. If a ceiling fired, that is both a fact the subject is owed
  // (above) and the operational signal that this export has outgrown a
  // synchronous request-thread build — the trigger for the async job in
  // FUTURE_REMEDIATION. User id only; the export's CONTENTS are personal data
  // and must not reach the logs.
  if (audit.truncated || assignments.truncated) {
    console.warn(
      `[gdpr/export] user ${user.id} hit the ${HISTORY_ROW_CEILING}/series ceiling ` +
      `(audit_trail=${audit.truncated}, crew_assignments=${assignments.truncated}) — ` +
      'export returned partial and said so'
    )
  }

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status:  200,
    headers: {
      'Content-Type':        'application/json',
      'Content-Disposition': `attachment; filename="fieldstay-data-export-${new Date().toISOString().split('T')[0]}.json"`,
    },
  })
}
