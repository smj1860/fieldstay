import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { haversineKm, proximityScore, clamp01 } from '@/lib/scoring/geo'

// Compliance nudges the score down instead of a second hard filter layered on
// top of hard_blocked exclusion — grace_period vendors already had their
// documents expire (worse than merely expiring soon), so they're penalized
// more heavily, but neither state disqualifies them the way hard_blocked does.
const COMPLIANCE_FACTOR: Record<string, number> = {
  hard_blocked:  0,     // never reached — filtered out of the candidate pool entirely
  grace_period:  0.7,
  expiring_soon: 0.85,
  compliant:     1.0,
  no_documents:  1.0,
}

interface VendorCandidate {
  id:         string
  name:       string
  lat:        number | null
  lng:        number | null
  avg_rating: number | null
}

export const autoAssignVendor = inngest.createFunction(
  { id: 'auto-assign-vendor', name: 'Auto-Suggest Vendor for Work Order', retries: 2 },
  { event: 'work-order/vendor-suggestion.requested' },
  async ({ event, step }) => {
    const { work_order_id, property_id, org_id, category } = event.data

    const context = await step.run('load-context', async () => {
      const supabase = createServiceClient()

      const [
        { data: org },
        { data: property },
        { data: vendors },
        { data: complianceRows },
      ] = await Promise.all([
        supabase.from('organizations').select('vendor_auto_assign_mode').eq('id', org_id).single(),
        supabase.from('properties').select('id, lat, lng').eq('id', property_id).single(),
        supabase
          .from('vendors')
          .select('id, name, lat, lng, avg_rating')
          .eq('org_id', org_id)
          .eq('specialty', category)
          .eq('is_active', true),
        supabase.from('vendor_compliance_status').select('vendor_id, compliance_status').eq('org_id', org_id),
      ])

      const mode = org?.vendor_auto_assign_mode ?? 'disabled'
      if (mode !== 'suggest' || !vendors?.length) return null

      // Plain object, not a Map — step.run results are JSON-serialized for
      // Inngest's replay/memoization, and a Map silently deserializes back
      // as {} on replay. Same reasoning applies to familiarVendorIds below
      // (array, not Set).
      const complianceByVendor: Record<string, string> = {}
      for (const c of complianceRows ?? []) complianceByVendor[c.vendor_id] = c.compliance_status

      // Hard exclusion — no human in the loop yet to override a bad pick, so
      // a hard-blocked vendor (expired compliance docs, 31+ days) never enters
      // the candidate pool at all, mirroring crew's unavailable-date exclusion.
      const eligibleVendors = (vendors as VendorCandidate[]).filter(
        (v) => complianceByVendor[v.id] !== 'hard_blocked'
      )
      if (!eligibleVendors.length) return null

      // Familiarity: has this vendor done a work order at this property before?
      const { data: pastWOs } = await supabase
        .from('work_orders')
        .select('vendor_id')
        .eq('property_id', property_id)
        .eq('org_id', org_id)
        .neq('id', work_order_id)
        .not('vendor_id', 'is', null)
        .in('vendor_id', eligibleVendors.map((v) => v.id))

      const familiarVendorIds = [...new Set((pastWOs ?? []).map((w) => w.vendor_id as string))]

      // Workload: currently open (assigned/in_progress) work orders per vendor
      const { data: openWOs } = await supabase
        .from('work_orders')
        .select('vendor_id')
        .eq('org_id', org_id)
        .in('vendor_id', eligibleVendors.map((v) => v.id))
        .in('status', ['assigned', 'in_progress'])

      const workloadMap: Record<string, number> = {}
      for (const w of openWOs ?? []) {
        if (!w.vendor_id) continue
        workloadMap[w.vendor_id] = (workloadMap[w.vendor_id] ?? 0) + 1
      }

      return {
        property:  { lat: property?.lat ?? null, lng: property?.lng ?? null },
        vendors:   eligibleVendors,
        familiarVendorIds,
        workloadMap,
        complianceByVendor,
      }
    })

    if (!context) return { skipped: true, reason: 'disabled or no candidates' }

    const scored = await step.run('score-candidates', async () => {
      const { property, vendors, familiarVendorIds, workloadMap, complianceByVendor } = context
      const maxWorkload = Math.max(...(Object.values(workloadMap) as number[]), 1)
      const familiarSet = new Set(familiarVendorIds)

      return vendors
        .map((v) => {
          const proximity =
            v.lat && v.lng && property.lat && property.lng
              ? proximityScore(haversineKm(
                  Number(v.lat), Number(v.lng),
                  Number(property.lat), Number(property.lng),
                ))
              : 0.5

          const familiarity = familiarSet.has(v.id) ? 1.0 : 0.0
          const workload     = 1 - (workloadMap[v.id] ?? 0) / maxWorkload
          // avg_rating is 1-5 (numeric(3,2)); normalize to 0-1. Default to a
          // neutral 0.7 for vendors with no rating history yet, matching
          // crew's same-situation default in auto-assign-turnover.ts.
          const reliability = v.avg_rating !== null ? clamp01((Number(v.avg_rating) - 1) / 4) : 0.7

          const complianceStatus = complianceByVendor[v.id] ?? 'compliant'
          const complianceFactor = COMPLIANCE_FACTOR[complianceStatus] ?? 1.0

          const rawScore =
            proximity   * 0.35 +
            familiarity * 0.20 +
            workload    * 0.20 +
            reliability * 0.25

          return {
            vendor_id: v.id,
            name:      v.name,
            score:     rawScore * complianceFactor,
            breakdown: { proximity, familiarity, workload, reliability, complianceFactor },
          }
        })
        .sort((a, b) => b.score - a.score)
    })

    if (!scored.length) return { gap: true }

    const top = scored[0]!

    const reasons: string[] = []
    if (top.breakdown.familiarity === 1)  reasons.push('worked here before')
    if (top.breakdown.proximity   > 0.7)  reasons.push('nearby')
    if (top.breakdown.reliability > 0.8)  reasons.push('highly rated')
    if (top.breakdown.workload    > 0.8)  reasons.push('light workload')

    const reasoning = reasons.length
      ? `${top.name} — ${reasons.join(', ')}`
      : top.name

    await step.run('write-suggestion', async () => {
      const supabase = createServiceClient()
      await supabase
        .from('work_orders')
        .update({
          suggested_vendor_ids: [top.vendor_id],
          suggestion_reasoning: reasoning,
          suggestion_status:    'pending',
        })
        .eq('id', work_order_id)
    })

    await step.run('record-outcome', async () => {
      const supabase = createServiceClient()
      const { error } = await supabase.from('vendor_assignment_outcomes').upsert(
        {
          work_order_id,
          org_id,
          vendor_id:       top.vendor_id,
          property_id,
          suggested_score: Math.round(top.score * 100),
          score_breakdown: top.breakdown,
          was_suggestion:  true,
        },
        { onConflict: 'work_order_id,vendor_id' }
      )
      if (error) throw new Error(`Failed to record vendor assignment outcome: ${error.message}`)
    })

    return { action: 'suggested', top_vendor: top.name }
  }
)
