import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Maintenance' }

export default function MaintenancePage() {
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Maintenance</h1>
        <p className="page-subtitle">Manage your maintenance</p>
      </div>
      {/* TODO: build maintenance feature */}
    </div>
  )
}
