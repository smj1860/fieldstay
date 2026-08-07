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
// (org_id, external_id, external_source) uniqueness and silently combine two
// properties' booking history. Note the org_id in that key — it is PER ORG,
// which is why every lookup below must carry an org scope: two tenants
// co-hosting one listing legitimately hold the same external_id. Automatically merging two already-established
// properties is too risky to do unattended — instead the previous_id property
// is marked inactive and an audit event is written for manual PM
// reconciliation.
// ============================================================

import { unwrap, unwrapList } from '@/lib/supabase/unwrap'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { reportError }         from '@/lib/observability/report-error'

const PROVIDER = 'hospitable'

/**
 * The org that owns the Hospitable account this webhook came from.
 *
 * Returns null rather than guessing. Deliberately NOT `.maybeSingle()`:
 * integration_connections is UNIQUE (user_id, provider_id), so nothing stops
 * two FieldStay users — in two different orgs — connecting the same Hospitable
 * account and producing two rows for one external_user_id. maybeSingle turns
 * that into an error, and an error here previously degraded to "no scope",
 * which is the one outcome that must never happen. Ambiguous attribution and
 * no attribution get the same answer: null.
 */
async function resolveOwningOrg(
  supabase: ReturnType<typeof createServiceClient>,
  externalUserId: string | undefined,
): Promise<string | null> {
  if (!externalUserId) return null

  const res = await supabase
    .from('integration_connections')
    .select('org_id')
    .eq('provider_id',      PROVIDER)
    .eq('external_user_id', externalUserId)
    .limit(10)

  const rows = unwrapList(res, { site: 'inngest.hospitable-property-merge.connection-scope' })
  const orgIds = [...new Set(rows.map((r) => r.org_id))]
  return orgIds.length === 1 ? orgIds[0]! : null
}

export const hospPropertyMerge = inngest.createFunction(
  {
    id:      'hospitable-property-merge',
    name:    'Hospitable: Property Merge Remap',
    retries: 2,
  },
  { event: 'integration/hospitable.property_merged' as const },
  async ({ event, step, logger }) => {
    const { previous_external_id, new_external_id, external_user_id } = event.data

    const result = await step.run('remap-or-flag', async () => {
      const supabase = createServiceClient({ system: 'inngest:property-merge' })

      // ── Resolve the owning org. This is the ONLY tenant filter. ──────────
      //
      // It used to be optional: `if (scopedOrgId) query = query.eq('org_id',
      // …)`, documented as falling back to the older unscoped behaviour and
      // therefore "no worse than before". It was worse than it read, because
      // properties is UNIQUE (org_id, external_id, external_source) — PER ORG,
      // not globally — so two tenants legitimately hold the same Hospitable
      // external_id whenever a property is co-hosted. Unscoped, that gives
      // either:
      //
      //   • two matching rows -> .maybeSingle() errors, the error was
      //     discarded, and the run returned `skipped: no_previous_property`.
      //     The merge silently never happened for EITHER org; or
      //   • one matching row belonging to a DIFFERENT org -> this function
      //     renames that tenant's property external_id off one webhook
      //     belonging to another tenant, breaking their sync mapping.
      //
      // `status = 'active'` was the second half of the problem and is dropped
      // here. Elsewhere (lib/integrations/vault.ts, providers/ownerrez.ts)
      // requiring an active connection is right — those need working
      // credentials to call an API. Here the connection is used ONLY as a
      // tenant scope key, and a connection in 'error' (a token refresh that
      // failed), 'revoked', or 'disconnected' still tells us exactly which org
      // owns the rows. Filtering it out did not narrow the write, it widened
      // it. Production makes that concrete: all 5 connections are currently
      // non-active, so EVERY webhook took the unscoped path.
      const scopedOrgId = await resolveOwningOrg(supabase, external_user_id)

      if (!scopedOrgId) {
        // Cannot attribute this webhook to a tenant. Skipping is the only safe
        // action — a service-role write with no org filter is never the
        // fallback for "we don't know whose this is".
        reportError(new Error('Hospitable property-merge could not resolve an owning org'), {
          site:  'inngest.hospitable-property-merge.unattributable',
          extra: { has_external_user_id: Boolean(external_user_id), previous_external_id, new_external_id },
        })
        return { action: 'skipped', reason: 'unattributable' as const }
      }

      const previousRes = await supabase
        .from('properties')
        .select('id, org_id, name')
        .eq('org_id',          scopedOrgId)
        .eq('external_id',     previous_external_id)
        .eq('external_source', PROVIDER)
        .maybeSingle()

      // Unwrapped: a failed read returns null too, and reading that as "no such
      // property" is what turned the multi-match case into a silent success.
      const previousProperty = unwrap(previousRes, {
        site:  'inngest.hospitable-property-merge.previous-property',
        orgId: scopedOrgId,
      })

      if (!previousProperty) {
        return { action: 'skipped', reason: 'no_previous_property' as const }
      }

      const existingNewRes = await supabase
        .from('properties')
        .select('id')
        .eq('org_id',          scopedOrgId)
        .eq('external_id',     new_external_id)
        .eq('external_source', PROVIDER)
        .maybeSingle()

      const existingNewProperty = unwrap(existingNewRes, {
        site:  'inngest.hospitable-property-merge.new-property',
        orgId: scopedOrgId,
      })

      if (existingNewProperty) {
        // Both sides of the merge already exist as separate FieldStay
        // properties — flag for manual reconciliation rather than silently
        // combining two properties' booking/turnover/work-order history.
        const { error: deactivateError } = await supabase
          .from('properties')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('id', previousProperty.id)
          .eq('org_id', scopedOrgId)

        // Bound: discarded, a failed deactivation still wrote the audit event
        // and returned 'flagged_for_manual_review', so the PM would be told to
        // reconcile two properties while the stale one stayed active and kept
        // generating turnovers.
        if (deactivateError) {
          throw new Error(`Property deactivation failed: ${deactivateError.message}`)
        }

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
        .eq('org_id', scopedOrgId)

      if (error) throw new Error(`Property external_id remap failed: ${error.message}`)

      return { action: 'remapped' as const, propertyId: previousProperty.id }
    })

    logger.info(
      `[Hospitable property-merge] ${previous_external_id} → ${new_external_id}: ${result.action}`
    )

    return result
  }
)
