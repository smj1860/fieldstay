import { requireProperty } from '@/lib/auth'
import { firstIncompleteStep } from '@/lib/wizard'
import { redirect } from 'next/navigation'

interface Props {
  params: { id: string }
}

export default async function SetupIndexPage({ params }: Props) {
  const { property } = await requireProperty(params.id)
  const completed    = (property.setup_steps_completed as Record<string, boolean>) ?? {}
  const step         = firstIncompleteStep(completed)
  redirect(`/properties/${params.id}/setup/${step}`)
}
