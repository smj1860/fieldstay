import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function CrewLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // Verify the user has a crew_member record
  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, org_id')
    .eq('user_id', user.id)
    .single()

  if (!crew) redirect('/login')

  return (
    <div className="min-h-screen bg-accent-50 flex flex-col max-w-lg mx-auto">
      {/* Crew app header */}
      <header className="bg-brand-800 text-white px-4 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <span className="font-bold text-lg">FieldStay Crew</span>
          <p className="text-brand-200 text-xs">{crew.name}</p>
        </div>
        {/* Offline indicator — PowerSync handles this */}
        <div id="offline-indicator" className="hidden">
          <span className="bg-amber-400 text-amber-900 text-xs font-medium px-2 py-1 rounded-full">
            Offline
          </span>
        </div>
      </header>

      <main className="flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  )
}
