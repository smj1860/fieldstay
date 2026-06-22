import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { calculateHealthScore } from '@/lib/assets/health-score'
import { getPmEmailsByOrgIds } from '@/lib/inngest/helpers'
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
    const today = new Date()

    // ── 8.4: Daily Asset Health Score Recalculation ──────────────────────────
    const activeAssets = await step.run('find-assets-for-scoring', async (): Promise<Array<{
      id: string
      org_id: string
      property_id: string
      asset_type: string
      installation_date: string | null
      expected_lifespan_years: number | null
      estimated_replacement_cost: number | null
      health_score: number | null
    }>> => {
      const supabase = createServiceClient()
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
        const supabase = createServiceClient()
        const { data } = await supabase
          .from('asset_type_standards')
          .select('asset_type, lifespan_min_years, lifespan_max_years, avg_replacement_cost_high, age_weight, condition_weight')
        return data ?? []
      })

      const repairWOs = await step.run('fetch-asset-repair-history', async () => {
        const supabase = createServiceClient()
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

      // Batch-resolve PM emails for every org with active assets
      const assetPmEmailEntries = await step.run('find-asset-pm-emails', async () => {
        const supabase = createServiceClient()
        const emails = await getPmEmailsByOrgIds(supabase, Object.keys(assetsByOrg))
        return Array.from(emails.entries())
      })
      const assetPmEmailByOrg = new Map(assetPmEmailEntries)

      for (const [orgId, orgAssets] of Object.entries(assetsByOrg)) {
        await step.run(`score-org-assets-${orgId}`, async () => {
          const supabase = createServiceClient()
          type Crossing = { asset_type: string; property_id: string; oldScore: number; newScore: number }
          const crossings: Crossing[] = []
          const updates: Array<{ id: string; health_score: number; health_score_updated_at: string }> = []
          const now = new Date().toISOString()

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
              repair,
              { age: std.age_weight, condition: std.condition_weight }
            )

            updates.push({ id: asset.id, health_score: newScore, health_score_updated_at: now })

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

          if (updates.length > 0) {
            // Single round trip per org — upsert with onConflict: 'id' only updates
            // the columns provided; all other NOT NULL columns are untouched.
            await supabase
              .from('property_assets')
              .upsert(
                updates.map((u) => ({
                  id:                      u.id,
                  health_score:            u.health_score,
                  health_score_updated_at: u.health_score_updated_at,
                })),
                { onConflict: 'id' }
              )
          }

          if (crossings.length > 0) {
            const pmEmail = assetPmEmailByOrg.get(orgId) ?? null
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

      // ── Bayesian weight nudge: per-asset-type age vs. condition weight drift ──
      await step.run('bayesian-weight-nudge', async () => {
        const supabase = createServiceClient()

        const { data: assetRepairs } = await supabase
          .from('work_orders')
          .select('asset_id, actual_cost, estimated_cost, completed_date, assets:property_assets!asset_id(asset_type, installation_date, expected_lifespan_years)')
          .not('asset_id', 'is', null)
          .eq('status', 'completed')

        if (!assetRepairs?.length) return { nudged: 0 }

        type RepairRecord = {
          ageAtRepair: number
          repairCost:  number
          assetType:   string
        }
        const byType: Record<string, RepairRecord[]> = {}

        for (const wo of assetRepairs) {
          const assetInfo = Array.isArray(wo.assets) ? wo.assets[0] : wo.assets
          if (!assetInfo?.asset_type || !assetInfo.installation_date || !wo.completed_date) continue

          const installYear = new Date(assetInfo.installation_date).getFullYear()
          const repairYear   = new Date(wo.completed_date).getFullYear()
          const ageAtRepair  = Math.max(0, repairYear - installYear)
          const repairCost   = wo.actual_cost ?? wo.estimated_cost ?? 0

          ;(byType[assetInfo.asset_type] ??= []).push({
            ageAtRepair, repairCost, assetType: assetInfo.asset_type,
          })
        }

        const { data: currentStandards } = await supabase
          .from('asset_type_standards')
          .select('asset_type, age_weight, condition_weight, lifespan_min_years, lifespan_max_years')

        const MAX_NUDGE   = 2.0
        const MIN_WEIGHT  = 30
        const MAX_WEIGHT  = 70
        const MIN_REPAIRS = 5

        const updates: Array<{
          asset_type:        string
          age_weight:        number
          condition_weight:  number
          weight_updated_at: string
        }> = []

        for (const [assetType, repairs] of Object.entries(byType)) {
          if (repairs.length < MIN_REPAIRS) continue

          const std = currentStandards?.find((s) => s.asset_type === assetType)
          if (!std) continue

          const lifespan = Math.round((std.lifespan_min_years + std.lifespan_max_years) / 2) || 10

          const lateLifeRepairs = repairs.filter((r) => r.ageAtRepair / lifespan > 0.8).length
          const lateLifeRatio   = lateLifeRepairs / repairs.length

          const TARGET_LATE_RATIO = 0.6
          let ageNudge = 0

          if (lateLifeRatio > TARGET_LATE_RATIO) {
            ageNudge = +MAX_NUDGE * ((lateLifeRatio - TARGET_LATE_RATIO) / (1 - TARGET_LATE_RATIO))
          } else if (lateLifeRatio < (1 - TARGET_LATE_RATIO)) {
            ageNudge = -MAX_NUDGE * ((TARGET_LATE_RATIO - lateLifeRatio) / TARGET_LATE_RATIO)
          }

          if (Math.abs(ageNudge) < 0.1) continue

          const newAgeWeight = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, std.age_weight + ageNudge))
          const newCondWeight = 100 - newAgeWeight

          if (Math.abs(newAgeWeight - std.age_weight) < 0.05) continue

          updates.push({
            asset_type:        assetType,
            age_weight:        Math.round(newAgeWeight * 10) / 10,
            condition_weight:  Math.round(newCondWeight * 10) / 10,
            weight_updated_at: new Date().toISOString(),
          })
        }

        if (updates.length) {
          await supabase
            .from('asset_type_standards')
            .upsert(updates, { onConflict: 'asset_type' })
        }

        return { nudged: updates.length, asset_types_with_data: Object.keys(byType).length }
      })
    }

    // ── 8.13: COI & License Expiry Escalation ────────────────────────────────
    const expiringDocs = await step.run('find-expiring-compliance-docs', async (): Promise<Array<{
      id: string
      org_id: string
      vendor_id: string
      document_type: string
      document_name: string
      expiry_date: string | null
      vendors: { name: string } | { name: string }[] | null
    }>> => {
      const supabase = createServiceClient()
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

    // Pre-compute which docs hit an alert threshold so we can batch PM email lookups
    const dueAlerts = expiringDocs.flatMap((doc) => {
      if (!doc.expiry_date) return []
      const daysUntil = Math.floor(
        (new Date(doc.expiry_date).getTime() - today.getTime()) / 86_400_000
      )
      const hitThreshold = COMPLIANCE_ALERT_THRESHOLDS.find((t) => Math.abs(daysUntil - t) <= 1)
      if (hitThreshold === undefined) return []
      return [{ doc, hitThreshold }]
    })

    const compliancePmEmailEntries = await step.run('find-compliance-pm-emails', async () => {
      const supabase = createServiceClient()
      const orgIds = Array.from(new Set(dueAlerts.map((a) => a.doc.org_id)))
      const emails = await getPmEmailsByOrgIds(supabase, orgIds)
      return Array.from(emails.entries())
    })
    const compliancePmEmailByOrg = new Map(compliancePmEmailEntries)

    for (const { doc, hitThreshold } of dueAlerts) {
      await step.run(`compliance-alert-${doc.id}-t${hitThreshold}`, async () => {
        const supabase = createServiceClient()
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
        const pmEmail  = compliancePmEmailByOrg.get(doc.org_id) ?? null

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
