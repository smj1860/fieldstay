import { unwrap } from '@/lib/supabase/unwrap'
import { redirect }        from 'next/navigation'
import { createClient }    from '@/lib/supabase/server'
import { TimeOffRequest }  from '@/components/crew/time-off-request'

export default async function CrewAvailabilityPage() {
  const supabase                = await createClient()
  const { data: { user } }      = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // A failed read used to bounce the crew member to /login, which reads as
  // "you are signed out" during what is really a transient DB error.
  const crewMemberRes = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .maybeSingle()

  const crewMember = unwrap(crewMemberRes, { site: 'page.crew.availability' })
  if (!crewMember) redirect('/login')

  return (
    <div className="px-4 pt-4 pb-24">
      <TimeOffRequest
        crewMemberId={crewMember.id as string}
        orgId={crewMember.org_id as string}
      />
    </div>
  )
}
