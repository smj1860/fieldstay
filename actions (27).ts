import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Inventory' }

export default function InventoryPage() {
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Inventory</h1>
        <p className="page-subtitle">Manage your inventory</p>
      </div>
      {/* TODO: build inventory feature */}
    </div>
  )
}
