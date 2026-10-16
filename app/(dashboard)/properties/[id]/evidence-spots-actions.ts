'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgRole } from '@/lib/auth'
import { reportError } from '@/lib/observability/report-error'
import { verifyPropertyInOrg } from '@/lib/tenancy/verify'
import { isUuid } from '@/lib/validation/uuid'

// Claim photo spots: the per-property list of high-claim places that get a
// required photo on every turnover (lib/evidence/room-photos.ts). Changes apply
// to the NEXT generated turnover. There is no hard delete: a claim_spot
// checklist item keeps its link to the spot it came from, so removal is
// is_active = false.

export type SpotActionResult = { success: true } | { success: false; error: string }

const LABEL_MIN = 2
const LABEL_MAX = 120
const SECTION_MAX = 80
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

function cleanText(raw: string): string {
  return raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
}

function validateLabel(label: string): string | null {
  if (label.length < LABEL_MIN || label.length > LABEL_MAX) {
    return `Label must be ${LABEL_MIN} to ${LABEL_MAX} characters.`
  }
  return null
}

export async function addEvidenceSpot(input: {
  propertyId: string
  section:    string
  label:      string
}): Promise<SpotActionResult> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])
    if (!isUuid(input.propertyId)) return { success: false, error: 'Property not found.' }
    const section = cleanText(input.section)
    const label   = cleanText(input.label)
    if (section.length === 0 || section.length > SECTION_MAX) return { success: false, error: 'Choose a room or section.' }
    const labelError = validateLabel(label)
    if (labelError) return { success: false, error: labelError }

    const verified = await verifyPropertyInOrg(supabase, membership.org_id, input.propertyId, 'action.evidence-spots.add')
    if (!verified.ok) return { success: false, error: verified.error }

    // Re-adding a deactivated spot reactivates it (the UNIQUE would otherwise reject it).
    const { error } = await supabase
      .from('property_evidence_spots')
      .upsert(
        { org_id: membership.org_id, property_id: input.propertyId, section_name: section, label, is_active: true },
        { onConflict: 'property_id,section_name,label' },
      )
    if (error) {
      reportError(error, { site: 'action.evidence-spots.add', orgId: membership.org_id })
      return { success: false, error: 'Could not save the spot. Please try again.' }
    }
    revalidatePath(`/properties/${input.propertyId}/evidence`)
    return { success: true }
  } catch (err) {
    reportError(err, { site: 'action.evidence-spots.add' })
    return { success: false, error: 'Could not save the spot. Please try again.' }
  }
}

export async function renameEvidenceSpot(input: {
  propertyId: string
  spotId:     string
  label:      string
}): Promise<SpotActionResult> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])
    if (!isUuid(input.propertyId) || !isUuid(input.spotId)) return { success: false, error: 'Spot not found.' }
    const label = cleanText(input.label)
    const labelError = validateLabel(label)
    if (labelError) return { success: false, error: labelError }

    const { data, error } = await supabase
      .from('property_evidence_spots')
      .update({ label })
      .eq('id', input.spotId)
      .eq('org_id', membership.org_id)
      .eq('property_id', input.propertyId)
      .select('id')
      .maybeSingle()
    if (error) {
      // 23505: another spot in this room already has that label.
      if (error.code === '23505') return { success: false, error: 'This room already has a spot with that label.' }
      reportError(error, { site: 'action.evidence-spots.rename', orgId: membership.org_id })
      return { success: false, error: 'Could not rename the spot. Please try again.' }
    }
    if (!data) return { success: false, error: 'Spot not found.' }
    revalidatePath(`/properties/${input.propertyId}/evidence`)
    return { success: true }
  } catch (err) {
    reportError(err, { site: 'action.evidence-spots.rename' })
    return { success: false, error: 'Could not rename the spot. Please try again.' }
  }
}

export async function deactivateEvidenceSpot(input: {
  propertyId: string
  spotId:     string
}): Promise<SpotActionResult> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])
    if (!isUuid(input.propertyId) || !isUuid(input.spotId)) return { success: false, error: 'Spot not found.' }

    const { data, error } = await supabase
      .from('property_evidence_spots')
      .update({ is_active: false })
      .eq('id', input.spotId)
      .eq('org_id', membership.org_id)
      .eq('property_id', input.propertyId)
      .select('id')
      .maybeSingle()
    if (error) {
      reportError(error, { site: 'action.evidence-spots.deactivate', orgId: membership.org_id })
      return { success: false, error: 'Could not remove the spot. Please try again.' }
    }
    if (!data) return { success: false, error: 'Spot not found.' }
    revalidatePath(`/properties/${input.propertyId}/evidence`)
    return { success: true }
  } catch (err) {
    reportError(err, { site: 'action.evidence-spots.deactivate' })
    return { success: false, error: 'Could not remove the spot. Please try again.' }
  }
}
