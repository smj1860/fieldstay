'use server'

import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'

export type IcalState = { error?: string; success?: boolean }

export async function addIcalFeed(
  propertyId: string,
  _prev: IcalState | null,
  formData: FormData
): Promise<IcalState> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    const name   = (formData.get('name') as string)?.trim()
    const url    = (formData.get('url') as string)?.trim()
    const source = formData.get('source') as string || 'other'

    if (!name) return { error: 'Feed name is required' }
    if (!url)  return { error: 'Calendar URL is required' }
    if (!url.startsWith('http')) return { error: 'Please enter a valid URL' }

    const { error } = await supabase.from('ical_feeds').insert({
      property_id: propertyId,
      org_id:      membership.org_id,
      name, url, source,
    })

    if (error) {
      console.error('[addIcalFeed]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'ical.feed.added',
      targetType: 'property',
      targetId:   propertyId,
      metadata:   { name, source },
    })

    revalidatePath(`/properties/${propertyId}/setup/ical`)
    return { success: true }
  } catch (err) {
    console.error('[addIcalFeed]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deleteIcalFeed(feedId: string, propertyId: string): Promise<void> {
  try {
    const { supabase, membership, user } = await requireOrgMember()
    await supabase
      .from('ical_feeds')
      .delete()
      .eq('id', feedId)
      .eq('org_id', membership.org_id)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'ical.feed.deleted',
      targetType: 'ical_feed',
      targetId:   feedId,
    })

    revalidatePath(`/properties/${propertyId}/setup/ical`)
  } catch (err) {
    console.error('[deleteIcalFeed]', err)
    throw err
  }
}

export async function completeIcalStep(propertyId: string): Promise<void> {
  try {
    await markStepComplete(propertyId, 'ical')
    redirect(`/properties/${propertyId}/setup/inventory`)
  } catch (err) {
    unstable_rethrow(err)
    console.error('[completeIcalStep]', err)
    throw err
  }
}

export async function triggerSingleFeedSync(feedId: string, propertyId: string): Promise<void> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const { data: feed } = await supabase
      .from('ical_feeds')
      .select('id')
      .eq('id', feedId)
      .eq('org_id', membership.org_id)
      .eq('property_id', propertyId)
      .maybeSingle()

    if (!feed) return

    await inngest.send({
      name: 'ical/sync.requested',
      data: { feed_id: feedId, property_id: propertyId, org_id: membership.org_id },
    })

    revalidatePath(`/properties/${propertyId}/setup/ical`)
  } catch (err) {
    console.error('[triggerSingleFeedSync]', err)
    throw err
  }
}
