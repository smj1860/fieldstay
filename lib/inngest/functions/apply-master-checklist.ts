import { inngest }                          from '@/lib/inngest/client'
import { createServiceClient }              from '@/lib/supabase/server'
import { applyMasterChecklistToProperty }   from '@/lib/checklists/apply-master-template'

const BATCH_SIZE = 10

export const applyMasterChecklistJob = inngest.createFunction(
  { id: 'apply-master-checklist', name: 'Apply Master Checklist to Properties', retries: 2 },
  { event: 'checklist/master-template.apply.requested' },
  async ({ event, step }) => {
    const { org_id, property_ids, triggered_by } = event.data

    let applied = 0

    for (let i = 0; i < property_ids.length; i += BATCH_SIZE) {
      const batch = property_ids.slice(i, i + BATCH_SIZE)

      const batchApplied = await step.run(`apply-batch-${i / BATCH_SIZE}`, async () => {
        const supabase = createServiceClient()

        // Explicit ownership check — service client bypasses RLS so we must
        // enforce org isolation ourselves. One bulk query per batch; no per-row calls.
        const { data: ownedProps } = await supabase
          .from('properties')
          .select('id')
          .in('id', batch)
          .eq('org_id', org_id)

        const ownedIds = new Set((ownedProps ?? []).map((p: { id: string }) => p.id))

        let count = 0
        for (const propertyId of batch) {
          if (!ownedIds.has(propertyId)) {
            console.warn(
              `[apply-master-checklist] property ${propertyId} not owned by org ${org_id} — skipping`
            )
            continue
          }
          await applyMasterChecklistToProperty(propertyId, org_id, supabase, {
            force:   true,
            actorId: triggered_by,
          })
          count++
        }
        return count
      })

      applied += batchApplied
    }

    return { applied }
  }
)
