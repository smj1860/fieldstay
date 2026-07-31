import { requireProperty } from '@/lib/auth'
import { CrewSetup } from './crew-setup'
import { Card } from '@/components/ui/Card'
import type { Metadata } from 'next'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export const metadata: Metadata = { title: 'Crew Setup' }
interface Props { params: Promise<{ id: string }> }

export default async function CrewPage({ params }: Props) {
  const { id } = await params
  const { property, supabase, membership } = await requireProperty(id)

  const { data: crew, error: crewError } = await supabase
    .from('crew_members')
    .select('id, name, email, phone, preferred_contact, specialty, is_active')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.properties.id.setup.crew', orgId: membership.org_id }, crewError)
  return (
    <Card>
      <h2 className="text-lg font-semibold text-primary-themed mb-1">Crew</h2>
      <p className="text-sm text-accent-500 mb-6">
        Add the cleaning and maintenance crew members you work with. You&apos;ll assign
        specific crew to each turnover when it&apos;s created.
      </p>
      <CrewSetup propertyId={property.id} crew={crew ?? []} />
    </Card>
  )
}
