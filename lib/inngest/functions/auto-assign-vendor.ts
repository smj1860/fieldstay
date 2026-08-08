import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { haversineKm, proximityScore, clamp01 } from '@/lib/scoring/geo'
import type { Enums } from '@/types/database'
import { computeWorkloadMap, computeFamiliarIds } from '@/lib/scoring/pools'

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

/**
 * wo_category → vendor_specialty.
 *
 * The two enums are NOT the same set: `appliance`, `flooring`,
 * `windows_doors` and `structural` are work-order categories with no vendor
 * specialty of their own. Passing one straight into `.eq('specialty', …)`
 * makes PostgREST reject the whole query (22P02, invalid input value for enum
 * vendor_specialty) — and since that error was discarded, the function saw
 * "no vendors" and returned no suggestion, so auto-assign silently did
 * nothing for those four categories. They route to `general`, which is who
 * actually takes that work.
 */
const SPECIALTY_BY_CATEGORY: Record<Enums<'wo_category'>, Enums<'vendor_specialty'>> = {
  hvac:          'hvac',
  plumbing:      'plumbing',
  electrical:    'electrical',
  cleaning:      'cleaning',
  landscaping:   'landscaping',
  roofing:       'roofing',
  pest_control:  'pest_control',
  pool:          'pool',
  general:       'general',
  other:         'other',
  appliance:     'general',
  flooring:      'general',
  windows_doors: 'general',
  structural:    'general',
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
      const supabase = createServiceClient({ system: 'inngest:auto-assign-vendor' })

      const [
        { data: org,            error: orgError },
        { data: property,       error: propertyError },
        { data: vendors,        error: vendorsError },
        { data: complianceRows, error: complianceError },
      ] = await Promise.all([
        // maybeSingle(), not single(): a genuinely missing org/property must
        // stay a graceful skip (both are already null-handled below), whereas
        // single() reports zero rows as PGRST116 — which the error check above
        // would treat as a failure and retry.
        supabase.from('organizations').select('vendor_auto_assign_mode').eq('id', org_id).maybeSingle(),
        supabase.from('properties').select('id, lat, lng').eq('id', property_id).eq('org_id', org_id).maybeSingle(),
        supabase
          .from('vendors')
          .select('id, name, lat, lng, avg_rating')
          .eq('org_id', org_id)
          .eq('specialty', SPECIALTY_BY_CATEGORY[category])
          .eq('is_active', true),
        supabase.from('vendor_compliance_status').select('vendor_id, compliance_status').eq('org_id', org_id),
      ])

      // A failed read here is indistinguishable from "this org has no matching
      // vendors" once the error is discarded — both leave `vendors` empty and
      // the function returns no suggestion. Throwing lets Inngest retry a
      // transient failure instead of recording a silent non-suggestion.
      throwIfAnyQueryFailed(
        { site: 'inngest.auto-assign-vendor.load-context', orgId: org_id },
        orgError, propertyError, vendorsError, complianceError,
      )

      const mode = org?.vendor_auto_assign_mode ?? 'disabled'
      if (mode !== 'suggest' || !vendors?.length) return null

      // Plain object, not a Map — step.run results are JSON-serialized for
      // Inngest's replay/memoization, and a Map silently deserializes back
      // as {} on replay. Same reasoning applies to familiarVendorIds below
      // (array, not Set).
      const complianceByVendor: Record<string, string> = {}
      for (const c of complianceRows ?? []) {
        // vendor_compliance_status is a VIEW — vendor_id is nullable there.
        if (c.vendor_id === null || c.compliance_status === null) continue
        complianceByVendor[c.vendor_id] = c.compliance_status
      }

      // Hard exclusion — no human in the loop yet to override a bad pick, so
      // a hard-blocked vendor (expired compliance docs, 46+ days) never enters
      // the candidate pool at all, mirroring crew's unavailable-date exclusion.
      const eligibleVendors = (vendors as VendorCandidate[]).filter(
        (v) => complianceByVendor[v.id] !== 'hard_blocked'
      )
      if (!eligibleVendors.length) return null

      // Familiarity: has this vendor done a work order at this property before?
      // Both scoring reads report rather than throw: this function produces a
      // SUGGESTION a PM accepts or overrides (there is deliberately no
      // autopilot mode for vendors), so a degraded score is absorbed by the
      // human and failing the run outright would be worse than a weaker
      // suggestion. Discarded entirely, though, a failed read silently
      // removed a whole scoring signal — which is precisely what makes
      // "the suggestions are bad lately" impossible to explain.
      // Paginated, not .limit(): both of these are AGGREGATES — every row
      // changes the answer. Truncating at max_rows would not merely shorten a
      // list, it would silently under-count familiarity and workload, which
      // skews the ranking rather than shortening it. A property with a long
      // work-order history across a wide vendor pool is exactly where that
      // bites, and it is also where the suggestion matters most.
      //
      // fetchAllRows throws on a page error, which is stricter than the
      // report-and-continue stance below. That is the right trade here: a
      // partial page set is a wrong score, whereas a wholly absent read is at
      // least an obviously empty one.
      const pastWOs = await fetchAllRows<{ vendor_id: string | null }>(
        (from, to) => supabase
          .from('work_orders')
          .select('vendor_id')
          .eq('property_id', property_id)
          .eq('org_id', org_id)
          .neq('id', work_order_id)
          .not('vendor_id', 'is', null)
          .in('vendor_id', eligibleVendors.map((v) => v.id))
          .order('id', { ascending: true })
          .range(from, to),
        { label: `vendor-familiarity[org=${org_id}]` },
      )

      const familiarVendorIds = computeFamiliarIds(pastWOs, (w) => w.vendor_id)

      // Workload: currently open (assigned/in_progress) work orders per vendor
      // Same reasoning as the familiarity read, and this one skews harder:
      // an under-counted workload map makes busy vendors look idle, so the
      // most loaded vendor can score identically to the free one.
      const openWOs = await fetchAllRows<{ vendor_id: string | null }>(
        (from, to) => supabase
          .from('work_orders')
          .select('vendor_id')
          .eq('org_id', org_id)
          .in('vendor_id', eligibleVendors.map((v) => v.id))
          .in('status', ['assigned', 'in_progress'])
          .order('id', { ascending: true })
          .range(from, to),
        { label: `vendor-workload[org=${org_id}]` },
      )

      const workloadMap = computeWorkloadMap(openWOs, (w) => w.vendor_id)

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
      const supabase = createServiceClient({ system: 'inngest:auto-assign-vendor' })
      const { error } = await supabase
        .from('work_orders')
        .update({
          suggested_vendor_ids: [top.vendor_id],
          suggestion_reasoning: reasoning,
          suggestion_status:    'pending',
        })
        .eq('id', work_order_id)
        .eq('org_id', org_id)
      if (error) throw new Error(`Failed to write vendor suggestion: ${error.message}`)
    })

    await step.run('record-outcome', async () => {
      const supabase = createServiceClient({ system: 'inngest:auto-assign-vendor' })
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
