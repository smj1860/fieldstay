'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'

export type TurnoverActionState = { error?: string; success?: boolean }

// ── Crew assignment ──────────────────────────────────────────────────────────

export async function assignCrew(
  turnoverIds: string[],
  crewMemberId: string
): Promise<TurnoverActionState> {
  const { supabase, membership } = await requireOrgMember()

  // Verify all turnovers belong to this org
  const { data: turnovers } = await supabase
    .from('turnovers')
    .select('id')
    .in('id', turnoverIds)
    .eq('org_id', membership.org_id)

  if (!turnovers?.length) return { error: 'Turnovers not found' }

  // Verify crew member belongs to this org
  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name')
    .eq('id', crewMemberId)
    .eq('org_id', membership.org_id)
    .single()

  if (!crew) return { error: 'Crew member not found' }

  for (const turnover of turnovers) {
    // Remove existing assignments first (re-assign pattern)
    await supabase
      .from('turnover_assignments')
      .delete()
      .eq('turnover_id', turnover.id)

    // Insert new assignment
    await supabase.from('turnover_assignments').insert({
      turnover_id:    turnover.id,
      crew_member_id: crewMemberId,
    })

    // Update turnover status to assigned
    await supabase
      .from('turnovers')
      .update({ status: 'assigned' })
      .eq('id', turnover.id)
      .eq('status', 'pending_assignment') // only if not already further along
  }

  // Send push notification to the assigned crew member
  try {
    const { createServiceClient } = await import('@/lib/supabase/server')
    const serviceClient = createServiceClient()

    const { data: subs } = await serviceClient
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('crew_member_id', crewMemberId)

    if (subs && subs.length > 0) {
      const { sendPushToCrewMember } = await import('@/lib/push/client')

      const count = turnovers.length
      const { data: firstTurnover } = await serviceClient
        .from('turnovers')
        .select('checkout_datetime, properties(name)')
        .eq('id', turnovers[0]!.id)
        .single()

      const props    = firstTurnover?.properties
      const propName = Array.isArray(props)
        ? (props[0] as { name?: string } | undefined)?.name
        : (props as unknown as { name?: string } | null)?.name

      const body = count === 1 && propName
        ? `${propName} — ${new Date(firstTurnover!.checkout_datetime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
        : `${count} new assignment${count !== 1 ? 's' : ''} added`

      await sendPushToCrewMember(subs, {
        title: 'New Assignment',
        body,
        url:   '/crew',
      })
    }
  } catch (err) {
    // Push failure must never break the assignment
    console.error('[push] failed to notify crew member:', err)
  }

  revalidatePath('/turnovers')
  return { success: true }
}

// ── Status update ────────────────────────────────────────────────────────────

export async function updateTurnoverStatus(
  turnover_id: string,
  status: 'in_progress' | 'completed' | 'flagged' | 'cancelled',
  notes?: string
): Promise<TurnoverActionState> {
  const { supabase, membership, user } = await requireOrgMember()

  const update: Record<string, unknown> = { status }
  if (status === 'in_progress') {
    update.started_at = new Date().toISOString()
  }
  if (status === 'completed') {
    update.completed_at     = new Date().toISOString()
    update.completion_notes = notes ?? null
  }
  if (notes && status === 'flagged') {
    update.completion_notes = notes
  }

  const { error } = await supabase
    .from('turnovers')
    .update(update)
    .eq('id', turnover_id)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  // Fire completion event for PM notification
  if (status === 'completed') {
    const { data: t } = await supabase
      .from('turnovers')
      .select('property_id, org_id')
      .eq('id', turnover_id)
      .single()

    if (t) {
      await inngest.send({
        name: 'turnover/completed',
        data: {
          turnover_id,
          property_id:        t.property_id,
          org_id:             t.org_id,
          completed_by_crew_id: '',
          completed_at:       new Date().toISOString(),
        },
      })
    }
  }

  // Fire flagged event to auto-create draft work order
  if (status === 'flagged' && notes) {
    const { data: t } = await supabase
      .from('turnovers')
      .select('property_id')
      .eq('id', turnover_id)
      .single()

    if (t) {
      await inngest.send({
        name: 'turnover/flagged',
        data: {
          turnover_id,
          property_id: t.property_id,
          org_id:      membership.org_id,
          flag_notes:  notes,
          flagged_by:  user.id,
        },
      })
    }
  }

  revalidatePath('/turnovers')
  revalidatePath(`/turnovers/${turnover_id}`)
  return { success: true }
}

// ── Manual turnover creation ─────────────────────────────────────────────────

export async function createManualTurnover(
  _prev: TurnoverActionState | null,
  formData: FormData
): Promise<TurnoverActionState> {
  const { supabase, membership } = await requireOrgMember()

  const property_id        = formData.get('property_id') as string
  const checkout_date      = formData.get('checkout_date') as string
  const checkout_time      = formData.get('checkout_time') as string || '11:00'
  const checkin_date       = formData.get('checkin_date') as string
  const checkin_time       = formData.get('checkin_time') as string || '15:00'
  const notes              = (formData.get('notes') as string)?.trim() || null

  if (!property_id || !checkout_date || !checkin_date) {
    return { error: 'Property, checkout date, and check-in date are required' }
  }

  const checkoutDT = new Date(`${checkout_date}T${checkout_time}:00`)
  const checkinDT  = new Date(`${checkin_date}T${checkin_time}:00`)

  if (checkinDT <= checkoutDT) {
    return { error: 'Check-in must be after checkout' }
  }

  const windowMinutes = Math.round(
    (checkinDT.getTime() - checkoutDT.getTime()) / 60_000
  )
  const priority =
    windowMinutes < 120 ? 'urgent' :
    windowMinutes < 240 ? 'high'   : 'medium'

  // Get default checklist template for the property
  const { data: template } = await supabase
    .from('checklist_templates')
    .select('id')
    .eq('property_id', property_id)
    .eq('is_default', true)
    .single()

  const { data: turnover, error } = await supabase
    .from('turnovers')
    .insert({
      property_id,
      org_id:               membership.org_id,
      checkout_datetime:    checkoutDT.toISOString(),
      checkin_datetime:     checkinDT.toISOString(),
      window_minutes:       windowMinutes,
      status:               'pending_assignment',
      priority:             priority as never,
      auto_generated:       false,
      notes,
      checklist_template_id: template?.id ?? null,
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  await inngest.send({
    name: 'turnover/created',
    data: {
      turnover_id:       turnover.id,
      property_id,
      org_id:            membership.org_id,
      checkout_datetime: checkoutDT.toISOString(),
      checkin_datetime:  checkinDT.toISOString(),
      window_minutes:    windowMinutes,
    },
  })

  revalidatePath('/turnovers')
  return { success: true }
}

// ── Add crew to turnover (additive, no replace) ──────────────────────────────

export async function addCrewToTurnover(
  turnoverIds: string[],
  crewMemberId: string
): Promise<TurnoverActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { data: turnovers } = await supabase
    .from('turnovers')
    .select('id, status')
    .in('id', turnoverIds)
    .eq('org_id', membership.org_id)

  if (!turnovers?.length) return { error: 'Turnovers not found' }

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id')
    .eq('id', crewMemberId)
    .eq('org_id', membership.org_id)
    .single()

  if (!crew) return { error: 'Crew member not found' }

  for (const turnover of turnovers) {
    const { data: existing } = await supabase
      .from('turnover_assignments')
      .select('id')
      .eq('turnover_id', turnover.id)
      .eq('crew_member_id', crewMemberId)
      .maybeSingle()

    if (!existing) {
      await supabase.from('turnover_assignments').insert({
        turnover_id:    turnover.id,
        crew_member_id: crewMemberId,
      })
    }

    if (turnover.status === 'pending_assignment') {
      await supabase
        .from('turnovers')
        .update({ status: 'assigned' })
        .eq('id', turnover.id)
    }
  }

  revalidatePath('/turnovers')
  return { success: true }
}

// ── Remove one crew member from a turnover ───────────────────────────────────

export async function removeCrewFromTurnover(
  turnoverId: string,
  crewMemberId: string
): Promise<TurnoverActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { data: turnover } = await supabase
    .from('turnovers')
    .select('id, status')
    .eq('id', turnoverId)
    .eq('org_id', membership.org_id)
    .single()

  if (!turnover) return { error: 'Turnover not found' }

  await supabase
    .from('turnover_assignments')
    .delete()
    .eq('turnover_id', turnoverId)
    .eq('crew_member_id', crewMemberId)

  const { data: remaining } = await supabase
    .from('turnover_assignments')
    .select('id')
    .eq('turnover_id', turnoverId)

  if (!remaining?.length && turnover.status === 'assigned') {
    await supabase
      .from('turnovers')
      .update({ status: 'pending_assignment' })
      .eq('id', turnoverId)
  }

  revalidatePath('/turnovers')
  return { success: true }
}

// ── Trigger manual iCal sync ─────────────────────────────────────────────────

export async function triggerManualSync(orgId: string): Promise<void> {
  await inngest.send({ name: 'ical/sync.all.requested', data: {} })
  revalidatePath('/turnovers')
}
