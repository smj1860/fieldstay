import { requireAuth } from '@/lib/auth'
import { OnboardingForm } from './onboarding-form'

export default async function OnboardingPage() {
  const { user } = await requireAuth()

  return <OnboardingForm userEmail={user.email ?? ''} />
}
