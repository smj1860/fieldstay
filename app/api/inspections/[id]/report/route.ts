import { requireOrgMember } from '@/lib/auth'
import { dataExportLimiter, checkLimit } from '@/lib/rate-limit'
import { loadInspectionReport } from '@/lib/inspections/report/model'
import { renderInspectionReport } from '@/lib/inspections/report/render'
import { reportFilename, reportResponse, photosRequested } from '@/lib/inspections/report/response'

/**
 * One completed inspection, as a PDF — GET /api/inspections/[id]/report
 *
 * WITH PHOTOGRAPHS BY DEFAULT. @smj1860, 2026-08-25: "the photos only the pm
 * and he/she can share with the owner if wanted." `?photos=0` produces the
 * same document an owner would receive, so a PM forwarding one does not have
 * to describe which pages to remove first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RLS-ENFORCED CLIENT, NOT THE SERVICE ROLE
 *
 * `requireOrgMember()` already returns a client scoped to the caller's session,
 * and nothing here needs RLS bypassed: every read is one org's own data. So the
 * policies do the scoping and the explicit `.eq('org_id', …)` in the loader is
 * defence in depth rather than the only defence. The CPA export reaches for
 * `createServiceClient({ authorizedBy: membership })`; copying that here would
 * have removed the backstop for nothing.
 *
 * The photo download rides the same client, so the `inspection-photos` bucket's
 * own SELECT policy decides who may read an object rather than this route
 * inventing a second answer to that question.
 */
export async function GET(
  req:    Request,
  ctx:    { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params
  const { user, supabase, membership } = await requireOrgMember()

  // An auth gate proves WHO, not HOW OFTEN. This renders a multi-page PDF and,
  // with photographs, downloads up to 150 objects of up to 10MB each on the
  // request path — CLAUDE.md's own "Report and export caps" section sizes
  // `maxDuration` against exactly that cost. Abuse limiter → fails CLOSED, the
  // same call CLAUDE.md already makes for the SMS nudge budget: "a spend
  // ceiling must not disappear during an outage." An unthrottled request here
  // costs tens of seconds and up to ~1.5GB of memory, and a Redis outage is
  // precisely the moment a runaway loop hitting this endpoint would otherwise
  // go completely uncapped. A denied export can be retried once Redis is back;
  // an outage that ALSO lifts the one limiter standing between a bug (or an
  // abusive caller) and the platform's memory ceiling cannot be undone.
  const rl = await checkLimit(dataExportLimiter, `inspection-report:${user.id}`, {
    onError: 'deny',
    site:    'route.inspections.report.GET',
  })
  if (!rl.allowed) {
    return Response.json(
      { error: 'Export limit reached. Please try again shortly.' },
      { status: 429 },
    )
  }

  const report = await loadInspectionReport(supabase, {
    orgId:         membership.org_id,
    inspectionId:  id,
    includePhotos: photosRequested(new URL(req.url)),
  })

  // 404 covers three cases deliberately: no such inspection, one belonging to
  // another org, and one that is not finished. Distinguishing them would let a
  // caller enumerate which uuids exist in other tenants, and "in progress"
  // is not a document this endpoint has any version of.
  if (!report) {
    return Response.json({ error: 'Inspection not found.' }, { status: 404 })
  }

  return reportResponse(await renderInspectionReport(report), reportFilename(report))
}
