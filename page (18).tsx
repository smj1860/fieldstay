import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'My Assignments — FieldStay Crew' }

export default function CrewDashboardPage() {
  return (
    <div>
      <h2 className="text-xl font-bold text-accent-900 mb-4">My Assignments</h2>
      {/* TODO: PowerSync-powered offline turnover list */}
    </div>
  )
}
