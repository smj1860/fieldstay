// app/api/properties/[id]/history/export/route.ts
//
// CSV export for the property history view ("Show me what happened" —
// Implementation Instructions, Workstream 1) — GET
// /api/properties/[id]/history/export?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Modeled on app/api/assets/capex-csv/route.ts: requireOrgMember() +
// dataExportLimiter, CSV rows built and escaped by hand, Content-Disposition
// download header.

import { NextRequest } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { unwrap } from '@/lib/supabase/unwrap'
import { dataExportLimiter, checkLimit } from '@/lib/rate-limit'
import { loadPropertyHistory } from '@/lib/history/loadPropertyHistory'

function csvField(value: string | null): string {
  if (!value) return ''
  return `"${value.replace(/"/g, '""')}"`
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: propertyId } = await params
  const { supabase, user, membership } = await requireOrgMember()

  const rl = await checkLimit(dataExportLimiter, `property-history-csv:${user.id}`, {
    onError: 'allow',
    site:    'route.properties.history-export.GET',
  })
  if (!rl.allowed) {
    return Response.json({ error: 'Export limit reached. Please try again later.' }, { status: 429 })
  }

  // IDOR guard — org-scoped before anything else runs, same pattern as
  // lib/auth.ts's requireProperty() (not reused directly here: that helper
  // redirects on a miss, which is the right UX for a page, not a JSON API).
  const propertyRes = await supabase
    .from('properties')
    .select('id, name')
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)
    .maybeSingle()
  const property = unwrap(propertyRes, { site: 'api.properties.history-export', orgId: membership.org_id })
  if (!property) {
    return Response.json({ error: 'Property not found' }, { status: 404 })
  }

  const url  = new URL(req.url)
  const from = url.searchParams.get('from') ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const to   = url.searchParams.get('to')   ?? new Date().toISOString().slice(0, 10)

  const { events, totalCount, omittedCount } = await loadPropertyHistory({
    supabase,
    orgId:      membership.org_id,
    propertyId,
    from:       `${from}T00:00:00.000Z`,
    to:         `${to}T23:59:59.999Z`,
  })

  const rows: string[] = ['Timestamp,Type,Title,Detail,Actor']
  if (omittedCount > 0) {
    rows.push(csvField(`Showing ${events.length} of ${totalCount} events in this range — narrow the date range to see the rest.`))
  }
  for (const event of events) {
    rows.push([
      event.occurredAt,
      event.type,
      csvField(event.title),
      csvField(event.detail),
      csvField(event.actorName),
    ].join(','))
  }

  const csv = rows.join('\n')

  return new Response(csv, {
    headers: {
      'Content-Type':        'text/csv',
      'Content-Disposition': `attachment; filename="${property.name.replace(/[^a-z0-9]+/gi, '-')}-history-${from}-to-${to}.csv"`,
    },
  })
}
