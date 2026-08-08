'use server'

import { toDbEnum } from '@/lib/db-enums'
import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'
import { assertSafeExternalUrl, UnsafeUrlError } from '@/lib/security/url-guard'

import { reportError } from '@/lib/observability/report-error'
import { isRealQueryError, reportQueryError } from '@/lib/supabase/unwrap'
export type IcalState = { error?: string; success?: boolean }

/**
 * Save-time SSRF validation for a PM-supplied calendar URL.
 *
 * lib/inngest/functions/ical-sync.ts already fetches through safeFetch(), so
 * an unsafe feed can never actually be dereferenced — but that check only runs
 * when the hourly cron next fires. Until then the PM sees a feed that looks
 * saved and simply never syncs, with the reason buried in Inngest logs. Doing
 * the same validation here turns that into an immediate, actionable form
 * error.
 *
 * Deliberately uses assertSafeExternalUrl's DEFAULT protocol allowlist
 * (https: only) — exactly what safeFetch enforces on every hop at sync time.
 * Accepting http:// here would just move the rejection back to the cron, which
 * is the failure mode this closes. It also replaces the old
 * `url.startsWith('http')` check, which passed `httpfoo`, `http://127.0.0.1`,
 * and every alternate-encoding loopback spelling.
 *
 * Returns an error string, or null when the URL is safe.
 */
async function validateFeedUrl(url: string): Promise<string | null> {
  try {
    await assertSafeExternalUrl(url)
    return null
  } catch (err) {
    if (err instanceof UnsafeUrlError) return err.message
    throw err
  }
}

export async function addIcalFeed(
  propertyId: string,
  _prev: IcalState | null,
  formData: FormData
): Promise<IcalState> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    const name   = (formData.get('name') as string)?.trim()
    const url    = (formData.get('url') as string)?.trim()
    const source = toDbEnum('ical_source', formData.get('source') as string | null, 'other')

    if (!name) return { error: 'Feed name is required' }
    if (!url)  return { error: 'Calendar URL is required' }

    const urlError = await validateFeedUrl(url)
    if (urlError) return { error: urlError }

    const { data: property, error: propertyError } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .single()

    if (isRealQueryError(propertyError)) {
      reportQueryError(propertyError, { site: 'serverAction.properties.setup.ical.addIcalFeed.propertyLookup', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    if (!property) return { error: 'Property not found' }

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
    reportError(err, { site: 'serverAction.properties.setup.ical.addIcalFeed' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deleteIcalFeed(feedId: string, propertyId: string): Promise<void> {
  try {
    const { supabase, membership, user } = await requireOrgMember()
    const { error } = await supabase
      .from('ical_feeds')
      .delete()
      .eq('id', feedId)
      .eq('org_id', membership.org_id)

    if (error) throw error

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
    reportError(err, { site: 'serverAction.properties.setup.ical.deleteIcalFeed' })
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
    reportError(err, { site: 'serverAction.properties.setup.ical.completeIcalStep' })
    throw err
  }
}

export async function triggerSingleFeedSync(feedId: string, propertyId: string): Promise<void> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const { data: feed, error: feedError } = await supabase
      .from('ical_feeds')
      .select('id')
      .eq('id', feedId)
      .eq('org_id', membership.org_id)
      .eq('property_id', propertyId)
      .maybeSingle()

    if (feedError) throw feedError

    if (!feed) return

    await inngest.send({
      name: 'ical/sync.requested',
      data: { feed_id: feedId, property_id: propertyId, org_id: membership.org_id },
    })

    revalidatePath(`/properties/${propertyId}/setup/ical`)
  } catch (err) {
    console.error('[triggerSingleFeedSync]', err)
    reportError(err, { site: 'serverAction.properties.setup.ical.triggerSingleFeedSync' })
    throw err
  }
}
