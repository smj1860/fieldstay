'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrapList } from '@/lib/supabase/unwrap'
import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import {
  MAX_SPONSORS_PER_PROPERTY,
  ASSIGNMENT_MIN_PROPERTIES,
} from '@/lib/guidebook/resolve-property-sponsors'

/**
 * Writing per-property sponsor assignments.
 *
 * Every action here marks the properties it touches `sponsor_assignment_mode =
 * 'manual'` — INCLUDING when the effect is to remove every sponsor from a
 * property. That is the whole reason the column exists: zero assignment rows
 * on its own means "the manager has not chosen", and the automatic resolver
 * would cheerfully reinstate everything they just removed.
 */

export type AssignmentResult = { success: true } | { success: false; error: string }

/** Postgres unique-violation — the category-collision index firing. */
const UNIQUE_VIOLATION = '23505'

/** Postgres check-violation — the per-property 4-sponsor cap trigger firing. */
const CHECK_VIOLATION = '23514'

/**
 * The collision index and the cap trigger both report a raw Postgres code,
 * not a sentence. Translate them once, here, rather than letting either reach
 * a manager who has no way to know what
 * "guidebook_sponsor_assignments_named_slot_unique" means.
 */
function assignmentErrorMessage(err: { code?: string; message?: string }): string {
  if (err.code === UNIQUE_VIOLATION) {
    return 'That property already has a sponsor in this category. ' +
           'Each property can carry only one Morning Brew, Dinner & Pints, Rainy Day and ' +
           'Outdoor Adventure sponsor — swap the existing one out first.'
  }
  if (err.code === CHECK_VIOLATION) {
    return `A property can carry at most ${MAX_SPONSORS_PER_PROPERTY} sponsors. ` +
           'Remove one from that property before adding another.'
  }
  return 'Could not save those assignments. Please try again.'
}

/**
 * Whether this org is large enough for per-property assignment to be offered.
 *
 * A live property count, deliberately not a plan name: `organizations.plan` is
 * display-only in this codebase and has never gated a feature.
 *
 * Checked server-side as well as in the UI. The UI gate decides what renders;
 * this one decides what is allowed, and only the second one is a rule.
 */
async function orgIsAboveAssignmentTier(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  orgId:    string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('is_active', true)

  if (error) throw error
  return (count ?? 0) >= ASSIGNMENT_MIN_PROPERTIES
}

/**
 * Replaces the set of properties one sponsor appears on.
 *
 * This is the PRIMARY path: open a sponsor, tick the properties, save. A
 * thirty-property org is configured in about six of these.
 *
 * Every property that gains OR loses this sponsor becomes manual — losing one
 * is exactly the case that must not be re-added by the automatic resolver on
 * the next read.
 */
export async function setSponsorProperties(
  sponsorId:   string,
  propertyIds: string[],
): Promise<AssignmentResult> {
  try {
    const { user, membership } = await requireOrgRole(['admin', 'manager'])
    const supabase = createServiceClient({ authorizedBy: membership })
    const orgId    = membership.org_id

    if (!(await orgIsAboveAssignmentTier(supabase, orgId))) {
      return { success: false, error: `Per-property sponsors are available once you have ${ASSIGNMENT_MIN_PROPERTIES} properties.` }
    }

    // IDOR: prove the sponsor is this org's before touching anything. Org
    // membership alone says nothing about who owns this particular id.
    const sponsorRes = await supabase
      .from('guidebook_sponsors')
      .select('id, business_name')
      .eq('id', sponsorId)
      .eq('org_id', orgId)
      .maybeSingle()

    if (sponsorRes.error) throw sponsorRes.error
    if (!sponsorRes.data) return { success: false, error: 'Sponsor not found.' }

    // Same for the properties: filter the requested ids down to ones this org
    // actually owns rather than trusting the list.
    const ownedRes = await supabase
      .from('properties')
      .select('id')
      .eq('org_id', orgId)
      .in('id', propertyIds.length > 0 ? propertyIds : ['00000000-0000-0000-0000-000000000000'])
      .limit(Math.max(propertyIds.length, 1))

    const owned = unwrapList(ownedRes, { site: 'actions.setSponsorProperties', orgId }) as { id: string }[]
    const targetIds = owned.map((p) => p.id)

    // Diff-and-replace happens INSIDE the RPC, against a fresh read taken at
    // call time — not against a diff computed here from an earlier read that
    // could be stale by the time this reaches the database. The delete and
    // insert it performs are one function call, so a cap or category-collision
    // violation on the insert rolls back the removals too: the property set
    // ends up either fully updated or fully untouched, never partial.
    const rpcRes = await supabase.rpc('set_sponsor_properties', {
      p_org_id:       orgId,
      p_sponsor_id:   sponsorId,
      p_property_ids: targetIds,
    })
    if (rpcRes.error) {
      if (rpcRes.error.code === UNIQUE_VIOLATION || rpcRes.error.code === CHECK_VIOLATION) {
        return { success: false, error: assignmentErrorMessage(rpcRes.error) }
      }
      throw rpcRes.error
    }
    const { added: toAdd, removed: toRemove } = rpcRes.data as { added: string[]; removed: string[] }

    await markManual(supabase, orgId, [...toAdd, ...toRemove])

    await logAuditEvent({
      orgId,
      actorId: user.id,
      action:  'guidebook.sponsor_assignments.updated',
      metadata: {
        sponsor_id: sponsorId,
        added:      toAdd.length,
        removed:    toRemove.length,
      },
    })

    revalidatePath('/guidebook')
    return { success: true }
  } catch (err) {
    reportError(err, { site: 'actions.setSponsorProperties' })
    return { success: false, error: assignmentErrorMessage(err as { code?: string }) }
  }
}

/**
 * Replaces the set of sponsors on one property.
 *
 * The SECONDARY path — where a manager fixes the one cabin whose automatic
 * pick is wrong. Passing an empty list is a legitimate, deliberate act: it
 * means "no sponsors on this property", and the property stays at zero across
 * re-reads because it is marked manual.
 */
export async function setPropertySponsors(
  propertyId: string,
  sponsorIds: string[],
): Promise<AssignmentResult> {
  try {
    const { user, membership } = await requireOrgRole(['admin', 'manager'])
    const supabase = createServiceClient({ authorizedBy: membership })
    const orgId    = membership.org_id

    if (!(await orgIsAboveAssignmentTier(supabase, orgId))) {
      return { success: false, error: `Per-property sponsors are available once you have ${ASSIGNMENT_MIN_PROPERTIES} properties.` }
    }

    if (sponsorIds.length > MAX_SPONSORS_PER_PROPERTY) {
      return { success: false, error: `A property can carry at most ${MAX_SPONSORS_PER_PROPERTY} sponsors.` }
    }

    const propRes = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('org_id', orgId)
      .maybeSingle()

    if (propRes.error) throw propRes.error
    if (!propRes.data) return { success: false, error: 'Property not found.' }

    const ownedRes = await supabase
      .from('guidebook_sponsors')
      .select('id')
      .eq('org_id', orgId)
      .in('id', sponsorIds.length > 0 ? sponsorIds : ['00000000-0000-0000-0000-000000000000'])
      .limit(Math.max(sponsorIds.length, 1))

    const owned = unwrapList(ownedRes, { site: 'actions.setPropertySponsors', orgId }) as { id: string }[]
    const targetIds = owned.map((s) => s.id)

    // Replace wholesale, atomically: this action states the property's
    // complete set. One RPC call is one implicit transaction, so a cap or
    // category-collision violation on the insert rolls back the delete too —
    // the property ends up either fully replaced or fully untouched, never
    // wiped-and-stuck-empty on a failed insert.
    const rpcRes = await supabase.rpc('replace_property_sponsors', {
      p_org_id:      orgId,
      p_property_id: propertyId,
      p_sponsor_ids: targetIds,
    })
    if (rpcRes.error) {
      if (rpcRes.error.code === UNIQUE_VIOLATION || rpcRes.error.code === CHECK_VIOLATION) {
        return { success: false, error: assignmentErrorMessage(rpcRes.error) }
      }
      throw rpcRes.error
    }

    await markManual(supabase, orgId, [propertyId])

    await logAuditEvent({
      orgId,
      actorId: user.id,
      action:  'guidebook.sponsor_assignments.updated',
      metadata: { property_id: propertyId, sponsors: targetIds.length },
    })

    revalidatePath('/guidebook')
    return { success: true }
  } catch (err) {
    reportError(err, { site: 'actions.setPropertySponsors' })
    return { success: false, error: assignmentErrorMessage(err as { code?: string }) }
  }
}

/**
 * Hands one property back to the automatic resolver.
 *
 * Deletes its assignment rows AND clears the manual marker — both, in that
 * order. Clearing the marker while leaving rows behind would leave a property
 * whose stored choice is invisible and unreachable.
 */
export async function resetPropertyToAutomatic(propertyId: string): Promise<AssignmentResult> {
  try {
    const { user, membership } = await requireOrgRole(['admin', 'manager'])
    const supabase = createServiceClient({ authorizedBy: membership })
    const orgId    = membership.org_id

    const propRes = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('org_id', orgId)
      .maybeSingle()

    if (propRes.error) throw propRes.error
    if (!propRes.data) return { success: false, error: 'Property not found.' }

    const del = await supabase
      .from('guidebook_sponsor_assignments')
      .delete()
      .eq('org_id', orgId)
      .eq('property_id', propertyId)
    if (del.error) throw del.error

    const upd = await supabase
      .from('properties')
      .update({ sponsor_assignment_mode: 'auto' })
      .eq('id', propertyId)
      .eq('org_id', orgId)
    if (upd.error) throw upd.error

    await logAuditEvent({
      orgId,
      actorId: user.id,
      action:  'guidebook.sponsor_assignments.updated',
      metadata: { property_id: propertyId, reset_to: 'auto' },
    })

    revalidatePath('/guidebook')
    return { success: true }
  } catch (err) {
    reportError(err, { site: 'actions.resetPropertyToAutomatic' })
    return { success: false, error: 'Could not reset that property. Please try again.' }
  }
}

/**
 * Marks properties manual in ONE statement.
 *
 * A loop of single-row updates here is the N+1 the guardrail exists to catch,
 * and a bulk assign touches every property in the org at once.
 */
async function markManual(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:    any,
  orgId:       string,
  propertyIds: string[],
): Promise<void> {
  const unique = [...new Set(propertyIds)]
  if (unique.length === 0) return

  const { error } = await supabase
    .from('properties')
    .update({ sponsor_assignment_mode: 'manual' })
    .eq('org_id', orgId)
    .in('id', unique)

  if (error) throw error
}
