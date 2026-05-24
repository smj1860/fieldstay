import { requireProperty } from '@/lib/auth'
import { CrewSetup } from './crew-setup'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Crew Setup' }
interface Props { params: { id: string } }

export default async function CrewPage({ params }: Props) {
  const { property, supabase, membership } = await requireProperty(params.id)

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, email, phone, preferred_contact, specialty, is_active')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-accent-900 mb-1">Crew</h2>
      <p className="text-sm text-accent-500 mb-6">
        Add the cleaning and maintenance crew members you work with. You'll assign
        specific crew to each turnover when it's created.
      </p>
      <CrewSetup propertyId={property.id} crew={crew ?? []} />
    </div>
  )
}
