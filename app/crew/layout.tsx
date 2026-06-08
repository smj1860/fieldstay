import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CrewShell } from './crew-shell'

export default async function CrewLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, org_id')
    .eq('user_id', user.id)
    .single()
  if (!crew) redirect('/login')

  return <CrewShell crewName={crew.name} userId={user.id}>{children}</CrewShell>
}
