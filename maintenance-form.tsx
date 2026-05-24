import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Owners' }

export default function OwnersPage() {
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Owners</h1>
        <p className="page-subtitle">Manage your owners</p>
      </div>
      {/* TODO: build owners feature */}
    </div>
  )
}
