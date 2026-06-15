import { redirect }             from 'next/navigation'
import { createClient }         from '@/lib/supabase/server'
import { AvailabilityCalendar } from '@/components/crew/availability-calendar'

export default async function CrewAvailabilityPage() {
  const supabase                = await createClient()
  const { data: { user } }      = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: crewMember } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .single()

  if (!crewMember) redirect('/login')

  return (
    <div className="px-4 pt-4 pb-24">
      <h1 className="text-xl font-bold text-accent-900 mb-1">My Availability</h1>
      <p className="text-sm text-accent-500 mb-6">
        Mark days you&apos;re unavailable so your manager can schedule
        accordingly. Changes sync instantly when you&apos;re online.
      </p>

      <div className="bg-white rounded-2xl border border-accent-100 shadow-sm p-4">
        <AvailabilityCalendar
          crewMemberId={crewMember.id as string}
          orgId={crewMember.org_id as string}
        />
      </div>
    </div>
  )
}
