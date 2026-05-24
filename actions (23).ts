import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Communications' }

export default function CommunicationsPage() {
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Communications</h1>
        <p className="page-subtitle">Manage your communications</p>
      </div>
      {/* TODO: build communications feature */}
    </div>
  )
}
