import { after } from 'next/server'

import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import {
  validatePortalToken,
  resolvePortalScope,
  authorizesProperty,
} from '@/lib/owner-portal/token'
import { loadInspectionReport } from '@/lib/inspections/report/model'
import { renderInspectionReport } from '@/lib/inspections/report/render'
import { reportFilename, reportResponse } from '@/lib/inspections/report/response'

/**
 * One completed inspection, for the owner —
 * GET /api/owner/[token]/inspections/[id]/report
 *
 * @smj1860, 2026-08-25: "the owner portal should just get the one inspection
 * each time it's done and the owner can always look back at past ones […] both
 * owner and pm can download the report itself. the photos only the pm."
 *
 * So: the same document body the PM gets, no photo log, and no whole-history
 * export — an owner browses the history in the portal rather than exporting it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO CHECKS, AND THE SECOND ONE IS THE POINT
 *
 * The token proves which ORG and which PROPERTIES. Scoping the read to the org
 * alone would be wrong in the ordinary case, not an edge one: an org holds
 * every owner's properties, so an org-scoped lookup by inspection id hands one
 * owner another owner's inspection at the same management company. That is the
 * IDOR the standing checklist names, in its sharpest form — the caller here is
 * unauthenticated and the id is the whole request.
 *
 * `authorizesProperty` is therefore not a formality. A multi-property token
 * legitimately spans several properties, so "this token is valid" and "this
 * token may have THAT inspection" are different questions and both get asked.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO RATE LIMITER IN THIS FILE
 *
 * `/api/owner` is registered in proxy.ts's TOKEN_ROUTES and matched by
 * `rateLimiterForPathname()` to `ownerPortalRatelimit`, so the throttle runs in
 * middleware before this handler is reached — the same treatment /owner/ pages
 * get. An inline limiter here would be a second, differently-configured answer
 * to a question already answered. `unit/guardrails/public-route-rate-limiting`
 * enforces that the prefix and the branch stay in step.
 */
export async function GET(
  _req: Request,
  ctx:  { params: Promise<{ token: string; id: string }> },
): Promise<Response> {
  const { token, id } = await ctx.params

  // Service role because there is no session to carry — the token IS the auth,
  // and it is validated in this file before anything is read.
  const supabase = createServiceClient({ publicSurface: 'owner-portal' })

  const validated = await validatePortalToken(supabase, token)
  if (!validated.ok) return notFound()

  const scope = await resolvePortalScope(supabase, validated.token)
  if (!scope) return notFound()

  const report = await loadInspectionReport(supabase, {
    orgId:        scope.orgId,
    inspectionId: id,
    // NEVER true on this route, and it is a literal rather than a variable so
    // there is no expression anyone could later make configurable by accident.
    // See the header comment in lib/inspections/report/model.ts: this is what
    // stops a private bucket being read on behalf of an unauthenticated caller.
    includePhotos: false,
  })
  if (!report) return notFound()

  // THE SECOND CHECK. The read above proved only that this inspection belongs
  // to the token's ORG.
  const inspection = report.inspections[0]
  if (!inspection || !authorizesProperty(scope, inspection.propertyId)) return notFound()

  // Deferred, because none of it is load-bearing for the response — the same
  // reason the portal page defers its access stamp. Token id and inspection id
  // only: no owner name, no email, no property address. An audit row is meant
  // to be readable by staff investigating an incident, not a second home for
  // data that should not be logged at all.
  after(() => {
    void logAuditEvent({
      orgId:      scope.orgId,
      action:     'owner_portal.inspection_report.downloaded',
      targetType: 'owner_portal_token',
      targetId:   validated.token.id,
      metadata:   { inspection_id: inspection.id, property_id: inspection.propertyId },
    })
  })

  return reportResponse(await renderInspectionReport(report), reportFilename(report))
}

/**
 * ONE response for every rejection: bad token, revoked, expired, no such
 * inspection, an inspection in another owner's property, and one still in
 * progress.
 *
 * Distinguishing them tells an unauthenticated caller which of those they got
 * right, which turns a guessable id into an oracle. The portal PAGE does
 * distinguish revoked from expired, and should — a real owner arriving at a
 * dead link deserves to know which. That is a page a person navigated to; this
 * is an id-keyed document endpoint, and the audiences are not the same.
 */
function notFound(): Response {
  return Response.json({ error: 'Not found.' }, { status: 404 })
}
