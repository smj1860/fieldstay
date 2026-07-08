// lib/inngest/functions/hospitable/property-merge.ts
// ============================================================
// Triggered by: integration/hospitable.property_merged
// Fired by:     handleWebhookEvent (hospitable.ts provider adapter) on the
//               Hospitable 'property.merged' webhook — { previous_id, new_id }.
//
// Hospitable deletes `previous_id` and the surviving property absorbs its
// listings under `new_id`. The FieldStay property row for previous_id must
// keep pointing at the same bookings/turnovers/work_orders (they reference
// the internal properties.id, not external_id), so the fix is a rename in
// place: UPDATE the existing row's external_id from previous_id to new_id.
// A separate property.changed webhook for the surviving property fires
// alongside this one and will upsert/refresh its other fields as usual.
//
// Edge case: if a FieldStay property row already exists under new_id (i.e.
// new_id was itself already a distinct, previously-synced property before
// the merge), a blind rename would collide with that row's
// (external_id, external_source) uniqueness and silently combine two
// properties' booking history. Automatically merging two already-established
// properties is too risky to do unattended — instead the previous_id property
// is marked inactive and an audit event is written for manual PM
// reconciliation.
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'

const PROVIDER = 'hospitable'

export const hospPropertyMerge = inngest.createFunction(
  {
    id:      'hospitable-property-merge',
    name:    'Hospitable: Property Merge Remap',
    retries: 2,
  },
  { event: 'integration/hospitable.property_merged' as const },
  async ({ event, step, logger }) => {
    const { previous_external_id, new_external_id } = event.data

    const result = await step.run('remap-or-flag', async () => {
      const supabase = createServiceClient()

      const { data: previousProperty } = await supabase
        .from('properties')
        .select('id, org_id, name')
        .eq('external_id',     previous_external_id)
        .eq('external_source', PROVIDER)
        .maybeSingle()

      if (!previousProperty) {
        return { action: 'skipped', reason: 'no_previous_property' as const }
      }

      const { data: existingNewProperty } = await supabase
        .from('properties')
        .select('id')
        .eq('external_id',     new_external_id)
        .eq('external_source', PROVIDER)
        .maybeSingle()

      if (existingNewProperty) {
        // Both sides of the merge already exist as separate FieldStay
        // properties — flag for manual reconciliation rather than silently
        // combining two properties' booking/turnover/work-order history.
        await supabase
          .from('properties')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('id', previousProperty.id)

        await logAuditEvent({
          orgId:      previousProperty.org_id,
          action:     'property.merge_conflict',
          targetType: 'property',
          targetId:   previousProperty.id,
          metadata: {
            provider:                PROVIDER,
            previous_external_id,
            new_external_id,
            surviving_property_id:   existingNewProperty.id,
            note: 'Both properties already existed in FieldStay — deactivated the old one; merge them manually.',
          },
        })

        return {
          action:              'flagged_for_manual_review' as const,
          previousPropertyId:  previousProperty.id,
          survivingPropertyId: existingNewProperty.id,
        }
      }

      const { error } = await supabase
        .from('properties')
        .update({ external_id: new_external_id, updated_at: new Date().toISOString() })
        .eq('id', previousProperty.id)

      if (error) throw new Error(`Property external_id remap failed: ${error.message}`)

      return { action: 'remapped' as const, propertyId: previousProperty.id }
    })

    logger.info(
      `[Hospitable property-merge] ${previous_external_id} → ${new_external_id}: ${result.action}`
    )

    return result
  }
)
