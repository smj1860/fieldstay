/**
 * CapEx CSV Export — GET /api/assets/capex-csv?year=2025
 */
import { unwrap } from '@/lib/supabase/unwrap'
import { requireOrgMember } from '@/lib/auth'
import { dataExportLimiter, checkLimit } from '@/lib/rate-limit'
import type { CapExProjectionPayload, CapExProjectionItem } from '@/lib/inngest/functions/capex-projections'

export async function GET(req: Request) {
  const { supabase, user, membership } = await requireOrgMember()

  // L-2 — see the note in app/api/assets/cpa-export/route.ts. Abuse limiter
  // → fails OPEN.
  const rl = await checkLimit(dataExportLimiter, `capex-csv:${user.id}`, {
    onError: 'allow',
    site:    'route.assets.capex-csv.GET',
  })
  if (!rl.allowed) {
    return Response.json(
      { error: 'Export limit reached. Please try again later.' },
      { status: 429 }
    )
  }

  const url  = new URL(req.url)
  const year = parseInt(url.searchParams.get('year') ?? String(new Date().getFullYear()), 10)

  // A failed read used to export an empty CSV, which looks like "no capex
  // planned" rather than an error.
  const milestoneRes = await supabase
    .from('org_milestones')
    .select('value')
    .eq('org_id', membership.org_id)
    .eq('milestone', `capex_projection_${year}`)
    .maybeSingle()

  const milestone = unwrap(milestoneRes, { site: 'api.assets.capex-csv', orgId: membership.org_id })

  const payload = milestone?.value as CapExProjectionPayload | null

  const rows: string[] = [
    // "Age Estimated" is its own column rather than a marker inside Age
    // (Years) — this CSV is opened in a spreadsheet and summed, and a "~4"
    // would not be a number there.
    'Replacement Year,Property,Asset,Asset Type,Age (Years),Age Estimated,% of Lifespan,Health Score,Cost Low,Cost High',
  ]

  if (payload) {
    const sortedYears = Object.keys(payload.projections).map(Number).sort((a, b) => a - b)
    for (const projYear of sortedYears) {
      for (const item of payload.projections[projYear].items as CapExProjectionItem[]) {
        rows.push([
          projYear,
          `"${item.property_name.replace(/"/g, '""')}"`,
          `"${item.asset_name.replace(/"/g, '""')}"`,
          item.asset_type.replace(/_/g, ' '),
          item.age_years,
          item.age_estimated ? 'yes' : 'no',
          `${item.pct_of_lifespan}%`,
          item.health_score ?? '',
          item.cost_low,
          item.cost_high,
        ].join(','))
      }
    }
  }

  const csv = rows.join('\n')

  return new Response(csv, {
    headers: {
      'Content-Type':        'text/csv',
      'Content-Disposition': `attachment; filename="capex-forecast-${year}.csv"`,
    },
  })
}
