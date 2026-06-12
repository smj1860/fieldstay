'use server'

import { createClient } from '@/lib/supabase/server'

export type ReportIssueResult = { success?: boolean; error?: string }

async function requireCrewMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .not('invite_accepted_at', 'is', null)
    .single()
  if (!crew) throw new Error('Crew member not found')

  return { supabase, crew }
}

export async function reportTurnoverIssue(
  turnoverId: string,
  title: string,
  description: string | null,
  priority: 'medium' | 'high' | 'urgent',
): Promise<ReportIssueResult> {
  try {
    if (!title.trim()) return { error: 'Please describe the issue.' }

    const { supabase, crew } = await requireCrewMember()

    const { data: turnover } = await supabase
      .from('turnovers')
      .select('id, property_id, org_id')
      .eq('id', turnoverId)
      .eq('org_id', crew.org_id)
      .single()

    if (!turnover) return { error: 'Turnover not found' }

    const { error } = await supabase.from('work_orders').insert({
      org_id:      turnover.org_id,
      property_id: turnover.property_id,
      title:       title.trim(),
      description: description?.trim() || null,
      priority,
      status: 'pending',
      source: 'crew_flag',
    })

    if (error) {
      console.error('[reportTurnoverIssue]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    return { success: true }
  } catch (err) {
    console.error('[reportTurnoverIssue]', err)
    return { error: 'Failed to report issue' }
  }
}
