/**
 * CapEx CSV Export — GET /api/assets/capex-csv?year=2025
 */
import { requireOrgMember } from '@/lib/auth'
import type { CapExProjectionPayload, CapExProjectionItem } from '@/lib/inngest/functions/capex-projections'

export async function GET(req: Request) {
  const { supabase, membership } = await requireOrgMember()

  const url  = new URL(req.url)
  const year = parseInt(url.searchParams.get('year') ?? String(new Date().getFullYear()), 10)

  const { data: milestone } = await supabase
    .from('org_milestones')
    .select('value')
    .eq('org_id', membership.org_id)
    .eq('milestone', `capex_projection_${year}`)
    .maybeSingle()

  const payload = milestone?.value as CapExProjectionPayload | null

  const rows: string[] = [
    'Replacement Year,Property,Asset,Asset Type,Age (Years),% of Lifespan,Health Score,Cost Low,Cost High',
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
