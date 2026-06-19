'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'

export type TurnoverActionState = { error?: string; success?: boolean; warning?: string }

// ── Crew assignment ──────────────────────────────────────────────────────────

export async function assignCrew(
  turnoverIds: string[],
  crewMemberId: string
): Promise<TurnoverActionState> {
  const { supabase, membership } = await requireOrgMember()

  // Verify all turnovers belong to this org
  const { data: turnovers } = await supabase
    .from('turnovers')
    .select('id, checkout_datetime')
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

  const ids = turnovers.map(t => t.id)

  // Time-off check — non-blocking, since a PM may want to override
  const turnoverDates = [...new Set(turnovers.map(t => t.checkout_datetime.split('T')[0]))]
  const { data: timeOff } = await supabase
    .from('crew_availability')
    .select('available_date')
    .eq('org_id', membership.org_id)
    .eq('crew_member_id', crewMemberId)
    .eq('is_available', false)
    .in('available_date', turnoverDates)

  const timeOffCount = timeOff?.length ?? 0

  // Batch: remove other-crew assignments across all turnovers in one query
  await supabase
    .from('turnover_assignments')
    .delete()
    .in('turnover_id', ids)
    .neq('crew_member_id', crewMemberId)

  // Batch: upsert this crew member for all turnovers at once
  await supabase.from('turnover_assignments').upsert(
    ids.map(id => ({ turnover_id: id, crew_member_id: crewMemberId })),
    { onConflict: 'turnover_id,crew_member_id', ignoreDuplicates: true }
  )

  // Batch: advance status for all pending_assignment turnovers at once
  await supabase
    .from('turnovers')
    .update({ status: 'assigned' })
    .in('id', ids)
    .eq('status', 'pending_assignment')

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
  if (timeOffCount > 0) {
    return {
      success: true,
      warning: `${crew.name} marked time off on ${timeOffCount} of the assigned date(s).`,
    }
  }
  return { success: true }
}

// ── Status update ────────────────────────────────────────────────────────────

export async function updateTurnoverStatus(
  turnover_id: string,
  status: 'in_progress' | 'completed' | 'flagged' | 'cancelled',
  notes?: string
): Promise<TurnoverActionState> {
  const { supabase, membership, user } = await requireOrgMember()

  const { data: existing } = await supabase
    .from('turnovers')
    .select('status')
    .eq('id', turnover_id)
    .eq('org_id', membership.org_id)
    .single()

  const wasAlreadyCompleted = existing?.status === 'completed'

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

  if (error) {
    console.error('[updateTurnoverStatus]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  // Fire completion event for PM notification (skip if already completed —
  // re-saving completion notes shouldn't re-trigger downstream automations)
  if (status === 'completed' && !wasAlreadyCompleted) {
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

  if (error) {
    console.error('[createManualTurnover]', error)
    return { error: 'Operation failed. Please try again.' }
  }

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
    .select('id, status, checkout_datetime, checkin_datetime')
    .in('id', turnoverIds)
    .eq('org_id', membership.org_id)

  if (!turnovers?.length) return { error: 'Turnovers not found' }

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name')
    .eq('id', crewMemberId)
    .eq('org_id', membership.org_id)
    .single()

  if (!crew) return { error: 'Crew member not found' }

  const verifiedIds = turnovers.map(t => t.id)

  // Fetch all existing assignments for this crew + these turnovers in one query
  const { data: currentAssignments } = await supabase
    .from('turnover_assignments')
    .select('turnover_id')
    .in('turnover_id', verifiedIds)
    .eq('crew_member_id', crewMemberId)

  const alreadyAssigned = new Set((currentAssignments ?? []).map(a => a.turnover_id))

  // Batch insert only the missing assignments
  const toInsert = verifiedIds.filter(id => !alreadyAssigned.has(id))
  if (toInsert.length > 0) {
    await supabase.from('turnover_assignments').insert(
      toInsert.map(id => ({ turnover_id: id, crew_member_id: crewMemberId }))
    )
  }

  // Batch advance pending_assignment turnovers to assigned
  const pendingIds = turnovers
    .filter(t => t.status === 'pending_assignment')
    .map(t => t.id)
  if (pendingIds.length > 0) {
    await supabase.from('turnovers').update({ status: 'assigned' }).in('id', pendingIds)
  }

  // Conflict detection — check for overlapping assignments for this crew member
  const { data: existingAssignments } = await supabase
    .from('turnover_assignments')
    .select('turnover_id, turnovers!inner(checkout_datetime, checkin_datetime, status)')
    .eq('crew_member_id', crewMemberId)
    .not('turnovers.status', 'in', '("completed","cancelled")')

  let conflictCount = 0
  for (const newT of turnovers) {
    const newStart = new Date((newT as unknown as { checkout_datetime: string }).checkout_datetime).getTime()
    const newEnd   = new Date((newT as unknown as { checkin_datetime: string }).checkin_datetime ?? (newT as unknown as { checkout_datetime: string }).checkout_datetime).getTime()
    for (const a of (existingAssignments ?? [])) {
      if (a.turnover_id === newT.id) continue
      const existing_turnovers = Array.isArray(a.turnovers) ? a.turnovers[0] : a.turnovers
      if (!existing_turnovers) continue
      const existStart = new Date(existing_turnovers.checkout_datetime).getTime()
      const existEnd   = new Date(existing_turnovers.checkin_datetime).getTime()
      if (newStart < existEnd && newEnd > existStart) conflictCount++
    }
  }

  // Time-off check — non-blocking, since a PM may want to override
  const turnoverDates = [...new Set(turnovers.map(t => t.checkout_datetime.split('T')[0]))]
  const { data: timeOff } = await supabase
    .from('crew_availability')
    .select('available_date')
    .eq('org_id', membership.org_id)
    .eq('crew_member_id', crewMemberId)
    .eq('is_available', false)
    .in('available_date', turnoverDates)

  const timeOffCount = timeOff?.length ?? 0

  revalidatePath('/turnovers')
  const warnings: string[] = []
  if (conflictCount > 0) warnings.push(`${crew.name} may have a scheduling conflict with ${conflictCount} other turnover(s).`)
  if (timeOffCount > 0)  warnings.push(`${crew.name} marked time off on ${timeOffCount} of the assigned date(s).`)

  if (warnings.length > 0) return { success: true, warning: warnings.join(' ') }
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

// ── Accept auto-assignment suggestion ────────────────────────────────────────

export async function acceptSuggestion(turnoverId: string): Promise<TurnoverActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { data: turnover } = await supabase
    .from('turnovers')
    .select('id, status, suggested_crew_ids')
    .eq('id', turnoverId)
    .eq('org_id', membership.org_id)
    .single()

  if (!turnover) return { error: 'Turnover not found' }

  const crewIds = (turnover.suggested_crew_ids as string[] | null) ?? []
  if (!crewIds.length) return { error: 'No suggestion to accept' }

  await supabase.from('turnover_assignments').upsert(
    crewIds.map(crewId => ({ turnover_id: turnoverId, crew_member_id: crewId })),
    { onConflict: 'turnover_id,crew_member_id', ignoreDuplicates: true }
  )

  await supabase
    .from('turnovers')
    .update({ status: 'assigned', suggestion_status: 'accepted' })
    .eq('id', turnoverId)

  try {
    const { createServiceClient } = await import('@/lib/supabase/server')
    const service = createServiceClient()
    for (const crewId of crewIds) {
      await service.from('assignment_outcomes').upsert(
        { turnover_id: turnoverId, org_id: membership.org_id, crew_member_id: crewId, was_accepted: true },
        { onConflict: 'turnover_id,crew_member_id', ignoreDuplicates: false }
      )
    }
  } catch {
    // Outcome recording must not break the acceptance flow
  }

  revalidatePath('/turnovers')
  return { success: true }
}

// ── Dismiss auto-assignment suggestion ───────────────────────────────────────

export async function dismissSuggestion(turnoverId: string): Promise<TurnoverActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { data: turnover } = await supabase
    .from('turnovers')
    .select('suggested_crew_ids')
    .eq('id', turnoverId)
    .eq('org_id', membership.org_id)
    .single()

  const { error } = await supabase
    .from('turnovers')
    .update({ suggestion_status: 'dismissed' })
    .eq('id', turnoverId)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error('[dismissSuggestion]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  const crewIds = (turnover?.suggested_crew_ids as string[] | null) ?? []
  if (crewIds.length) {
    try {
      const { createServiceClient } = await import('@/lib/supabase/server')
      const service = createServiceClient()
      for (const crewId of crewIds) {
        await service.from('assignment_outcomes').upsert(
          { turnover_id: turnoverId, org_id: membership.org_id, crew_member_id: crewId, was_accepted: false },
          { onConflict: 'turnover_id,crew_member_id', ignoreDuplicates: false }
        )
      }
    } catch {
      // Outcome recording must not break the dismissal flow
    }
  }

  revalidatePath('/turnovers')
  return { success: true }
}
