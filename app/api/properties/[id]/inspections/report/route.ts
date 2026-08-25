import { requireOrgMember } from '@/lib/auth'
import { dataExportLimiter, checkLimit } from '@/lib/rate-limit'
import { loadInspectionReport } from '@/lib/inspections/report/model'
import { renderInspectionReport } from '@/lib/inspections/report/render'
import { reportFilename, reportResponse, photosRequested } from '@/lib/inspections/report/response'

/**
 * A property's whole inspection history, as one PDF —
 * GET /api/properties/[id]/inspections/report
 *
 * @smj1860, 2026-08-25: "a single record should exist for each one done but an
 * option to get a PDF of all inspections should be there too."
 *
 * This is the artifact §1 describes: "A single audit earns nothing. Three years
 * of consistent quarterly safety inspections is the artifact." It is the
 * document that goes to an insurer, so it carries a cover page with the span,
 * the count, and — when the cap applied — a statement that it did.
 *
 * PM-ONLY, like the single-inspection route. The owner portal deliberately has
 * no equivalent: an owner gets each inspection as it completes and can look
 * back through the history in the portal itself.
 *
 * NO OWNERSHIP CHECK BEYOND THE ORG FILTER, and that is not an oversight. The
 * loader reads `inspections` scoped to `org_id` AND `property_id`, so a
 * property id belonging to another tenant matches no rows and returns null —
 * the 404 below. There is nothing to leak by not looking the property up first,
 * and looking it up would add a read whose only outcome is the same 404.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params
  const { user, supabase, membership } = await requireOrgMember()

  // Sized against the heavier of the two exports: up to 60 walks, each with its
  // answers, plus photographs. Fails OPEN — see the single-inspection route.
  const rl = await checkLimit(dataExportLimiter, `inspection-history:${user.id}`, {
    onError: 'allow',
    site:    'route.properties.inspections.report.GET',
  })
  if (!rl.allowed) {
    return Response.json(
      { error: 'Export limit reached. Please try again shortly.' },
      { status: 429 },
    )
  }

  const report = await loadInspectionReport(supabase, {
    orgId:         membership.org_id,
    propertyId:    id,
    includePhotos: photosRequested(new URL(req.url)),
  })

  if (!report) {
    return Response.json(
      { error: 'No completed inspections for this property.' },
      { status: 404 },
    )
  }

  return reportResponse(await renderInspectionReport(report), reportFilename(report))
}
