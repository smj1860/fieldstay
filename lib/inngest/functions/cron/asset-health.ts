import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { getPmEmailsByOrgIds } from '@/lib/inngest/helpers'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { logAuditEvents } from '@/lib/audit'
import {
  scoreAssets,
  persistScores,
  notifyThresholdCrossings,
  computeWeightNudge,
  type RepairRecord,
} from './asset-health-helpers'

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
        // Scoring is pure — its own step so a retry of persist or notify
        // below never re-runs the (cheap, deterministic) computation.
        const { updates, crossings } = await step.run(`score-org-assets-${orgId}`, async () => {
          const now = new Date().toISOString()
          return scoreAssets(orgAssets, standards, repairByAsset, now)
        })

        if (updates.length > 0) {
          await step.run(`persist-scores-${orgId}`, async () => {
            const supabase = createServiceClient()
            await persistScores(supabase, updates)
          })
        }

        if (crossings.length > 0) {
          // Its own step so a retry of persist-scores above can never
          // re-trigger a duplicate crossing-alert email.
          await step.run(`notify-crossings-${orgId}`, async () => {
            await notifyThresholdCrossings(assetPmEmailByOrg.get(orgId) ?? null, crossings)
          })
        }
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

        const updates: Array<{
          asset_type:        string
          age_weight:        number
          condition_weight:  number
          weight_updated_at: string
        }> = []
        const oldWeightsByType: Record<string, { age_weight: number; condition_weight: number }> = {}

        for (const [assetType, repairs] of Object.entries(byType)) {
          const std = currentStandards?.find((s) => s.asset_type === assetType)
          if (!std) continue

          const nudge = computeWeightNudge(repairs, std)
          if (!nudge) continue

          updates.push({
            asset_type:        assetType,
            ...nudge,
            weight_updated_at: new Date().toISOString(),
          })
          oldWeightsByType[assetType] = {
            age_weight:       std.age_weight,
            condition_weight: std.condition_weight,
          }
        }

        if (updates.length) {
          await supabase
            .from('asset_type_standards')
            .upsert(updates, { onConflict: 'asset_type' })

          // Platform-level event — no org_id, orgId intentionally omitted
          await logAuditEvents(
            updates.map((u) => ({
              action:     'asset.scoring_weights.auto_adjusted' as const,
              targetType: 'asset_type_standard',
              targetId:   u.asset_type,
              metadata:   {
                old_age_weight:       oldWeightsByType[u.asset_type]?.age_weight,
                new_age_weight:       u.age_weight,
                old_condition_weight: oldWeightsByType[u.asset_type]?.condition_weight,
                new_condition_weight: u.condition_weight,
              },
            }))
          )
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

          // Record AFTER a successful send. A retry on send failure will
          // attempt to send again (acceptable duplicate) rather than silently
          // drop the alert (unacceptable data loss).
          await supabase.from('org_milestones').insert({
            org_id:    doc.org_id,
            milestone: milestoneKey,
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
