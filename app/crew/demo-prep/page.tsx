import type { Metadata } from 'next'
import { DemoPrepClient } from './demo-prep-client'

export const metadata: Metadata = {
  title: 'Prep for Demo — FieldStay Crew',
  description: 'Verify the local cache is warm before running the offline crew demo.',
}

/**
 * Auth is handled by app/crew/layout.tsx (requireCrewMember + the
 * security.route.mismatch gate), which also mounts the DexieProvider this
 * page's client component reads from. Nothing extra is needed here.
 */
export default function CrewDemoPrepPage() {
  return <DemoPrepClient />
}
