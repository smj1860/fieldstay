import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { calculateHealthScore } from '@/lib/assets/health-score'
import { getPmEmail } from '@/lib/inngest/helpers'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'

// Alert thresholds (days relative to expiry): positive = before, negative = after
const COMPLIANCE_ALERT_THRESHOLDS = [30, 14, 7, 0, -14, -30]

/**
 * SCHEDULED: runs every morning at 8am CT (independent of other maintenance crons).
 *
 *  • 8.4  — daily asset health score recalculation + threshold-crossing alerts
 *  • 8.13 — COI & license expiry escalation
 */
export const dailyAssetHealth = inngest.createFunction(
  {
    id:      'cron-asset-health',
    name:    'Cron: Asset Health Scoring + COI Alerts',
    retries: 2,
  },
  { cron: '0 13 * * *' },
  async ({ step, logger }) => {
    const supabase = createServiceClient()
    const today    = new Date()

    // ── 8.4: Daily Asset Health Score Recalculation ──────────────────────────
    const activeAssets = await step.run('find-assets-for-scoring', async () => {
      const { data } = await supabase
        .from('property_assets')
        .select(`
          id, org_id, property_id, asset_type,
          installation_date, expected_lifespan_years,
          estimated_replacement_cost, health_score
        `)
        .eq('is_active', true)
      return data ?? []
    })

    logger.info(`Found ${activeAssets.length} active assets to score`)

    if (activeAssets.length > 0) {
      const standards = await step.run('fetch-asset-standards', async () => {
        const { data } = await supabase
          .from('asset_type_standards')
          .select('asset_type, lifespan_min_years, lifespan_max_years, avg_replacement_cost_high')
        return data ?? []
      })

      const repairWOs = await step.run('fetch-asset-repair-history', async () => {
        const { data } = await supabase
          .from('work_orders')
          .select('asset_id, actual_cost, estimated_cost, completed_date')
          .not('asset_id', 'is', null)
          .eq('status', 'completed')
        return data ?? []
      })

      // Aggregate repair history per asset
      const repairByAsset: Record<string, {
        total_repairs: number
        total_repair_cost: number
        last_serviced_at: string | null
      }> = {}
      for (const wo of repairWOs) {
        if (!wo.asset_id) continue
        const r = repairByAsset[wo.asset_id]
        if (!r) {
          repairByAsset[wo.asset_id] = {
            total_repairs:     1,
            total_repair_cost: wo.actual_cost ?? wo.estimated_cost ?? 0,
            last_serviced_at:  wo.completed_date ?? null,
          }
        } else {
          r.total_repairs++
          r.total_repair_cost += wo.actual_cost ?? wo.estimated_cost ?? 0
          if (wo.completed_date && (!r.last_serviced_at || wo.completed_date > r.last_serviced_at)) {
            r.last_serviced_at = wo.completed_date
          }
        }
      }

      // Group assets by org for batched updates + threshold alerts
      const assetsByOrg = activeAssets.reduce<Record<string, typeof activeAssets>>((acc, a) => {
        ;(acc[a.org_id] ??= []).push(a)
        return acc
      }, {})

      for (const [orgId, orgAssets] of Object.entries(assetsByOrg)) {
        await step.run(`score-org-assets-${orgId}`, async () => {
          type Crossing = { asset_type: string; property_id: string; oldScore: number; newScore: number }
          const crossings: Crossing[] = []

          for (const asset of orgAssets) {
            const std = standards.find((s) => s.asset_type === asset.asset_type)
            if (!std) continue

            const repair = repairByAsset[asset.id] ?? {
              total_repairs: 0, total_repair_cost: 0, last_serviced_at: null,
            }

            const newScore = calculateHealthScore(
              {
                installation_date:          asset.installation_date,
                expected_lifespan_years:    asset.expected_lifespan_years,
                estimated_replacement_cost: asset.estimated_replacement_cost,
              },
              std,
              repair
            )

            await supabase
              .from('property_assets')
              .update({
                health_score:            newScore,
                health_score_updated_at: new Date().toISOString(),
              })
              .eq('id', asset.id)

            // 8.5: detect threshold crossings (old > threshold >= new)
            const oldScore = asset.health_score
            if (oldScore !== null && newScore !== oldScore) {
              for (const threshold of [60, 40, 20]) {
                if (oldScore > threshold && newScore <= threshold) {
                  crossings.push({
                    asset_type:  asset.asset_type,
                    property_id: asset.property_id,
                    oldScore,
                    newScore,
                  })
                  break
                }
              }
            }
          }

          if (crossings.length > 0) {
            const pmEmail = await getPmEmail(supabase, orgId)
            if (pmEmail) {
              for (const c of crossings) {
                const label = c.newScore < 20 ? 'Critical' : c.newScore < 40 ? 'Poor' : 'Fair'
                await resend.emails.send({
                  from:    FROM,
                  to:      pmEmail,
                  subject: `Asset health alert — ${c.asset_type.replace(/_/g, ' ')} dropped to ${label}`,
                  html: await renderPmAlert({
                    heading:  'Asset health score dropped',
                    body:     `${c.asset_type.replace(/_/g, ' ')} health score dropped from ${c.oldScore} to ${c.newScore}/100 (${label}).`,
                    details: [
                      { label: 'Previous Score', value: `${c.oldScore}/100` },
                      { label: 'Current Score',  value: `${c.newScore}/100 (${label})` },
                    ],
                    ctaLabel: 'View Property →',
                    ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/properties/${c.property_id}`,
                  }),
                })
              }
            }
          }
        })
      }
    }

    // ── 8.13: COI & License Expiry Escalation ────────────────────────────────
    const expiringDocs = await step.run('find-expiring-compliance-docs', async () => {
      const { data } = await supabase
        .from('vendor_compliance_documents')
        .select(`
          id, org_id, vendor_id, document_type, document_name, expiry_date,
          vendors ( name )
        `)
        .eq('is_active', true)
        .not('expiry_date', 'is', null)
      return data ?? []
    })

    logger.info(`Checking ${expiringDocs.length} compliance docs for expiry alerts`)

    for (const doc of expiringDocs) {
      if (!doc.expiry_date) continue

      const daysUntil = Math.floor(
        (new Date(doc.expiry_date).getTime() - today.getTime()) / 86_400_000
      )

      // Find if this doc falls within ±1 day of any alert threshold
      const hitThreshold = COMPLIANCE_ALERT_THRESHOLDS.find(
        (t) => Math.abs(daysUntil - t) <= 1
      )
      if (hitThreshold === undefined) continue

      await step.run(`compliance-alert-${doc.id}-t${hitThreshold}`, async () => {
        const thresholdKey = hitThreshold >= 0
          ? `${hitThreshold}d_before`
          : `${Math.abs(hitThreshold)}d_after`
        const milestoneKey = `compliance_warning:${doc.id}:${thresholdKey}`

        // Dedup: skip if we already sent this threshold alert for this doc
        const { data: existing } = await supabase
          .from('org_milestones')
          .select('id')
          .eq('org_id', doc.org_id)
          .eq('milestone', milestoneKey)
          .maybeSingle()

        if (existing) return { skipped: true }

        const vendor   = Array.isArray(doc.vendors) ? doc.vendors[0] : doc.vendors
        const pmEmail  = await getPmEmail(supabase, doc.org_id)

        if (pmEmail) {
          const isPast  = hitThreshold < 0
          const daysAbs = Math.abs(hitThreshold)
          const daysText = hitThreshold === 0
            ? 'expires today'
            : isPast
            ? `expired ${daysAbs} day${daysAbs !== 1 ? 's' : ''} ago`
            : `expires in ${daysAbs} day${daysAbs !== 1 ? 's' : ''}`

          const subject = isPast
            ? `⛔ Compliance doc expired — ${vendor?.name} (${daysAbs}d overdue)`
            : hitThreshold === 0
            ? `⚠️ Compliance doc expires TODAY — ${vendor?.name}`
            : `⚠️ Compliance expiring in ${daysAbs}d — ${vendor?.name}`

          const docLabel = `${doc.document_name} (${doc.document_type.replace(/_/g, ' ')})`

          // Record dedup BEFORE sending so a retry after a failed send doesn't re-send
          await supabase.from('org_milestones').insert({
            org_id:    doc.org_id,
            milestone: milestoneKey,
          })

          await resend.emails.send({
            from:    FROM,
            to:      pmEmail,
            subject,
            html: await renderPmAlert({
              heading:  isPast ? 'Compliance document expired' : 'Compliance document expiring soon',
              body:     `${docLabel} for ${vendor?.name ?? 'this vendor'} ${daysText}.`,
              details: [
                { label: 'Vendor',      value: vendor?.name ?? null },
                { label: 'Expiry Date', value: doc.expiry_date },
              ],
              ctaLabel: 'Update Compliance Docs →',
              ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/vendors/${doc.vendor_id}`,
            }),
          })
        }

        return { sent: true, threshold: hitThreshold, vendor: vendor?.name }
      })
    }

    return {
      assets_scored:      activeAssets.length,
      compliance_checked: expiringDocs.length,
    }
  }
)
