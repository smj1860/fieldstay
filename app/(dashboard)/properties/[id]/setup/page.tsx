import { requireProperty } from '@/lib/auth'
import { firstIncompleteStep } from '@/lib/wizard'
import { redirect } from 'next/navigation'

interface Props {
  params: Promise<{ id: string }>
}

export default async function SetupIndexPage({ params }: Props) {
  const { id } = await params
  const { property } = await requireProperty(id)
  const completed    = (property.setup_steps_completed as Record<string, boolean>) ?? {}
  const step         = firstIncompleteStep(completed)
  redirect(`/properties/${id}/setup/${step}`)
}
