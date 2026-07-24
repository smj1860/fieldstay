'use client'

export function PropertyFilterSelect({
  properties,
  selectedPropertyId,
}: {
  properties: { id: string; name: string }[]
  selectedPropertyId?: string
}) {
  return (
    <select
      defaultValue={selectedPropertyId ?? ''}
      onChange={(e) => {
        const val = e.target.value
        globalThis.location.href = val
          ? `/capital-planning?property=${val}`
          : '/capital-planning'
      }}
      className="w-full rounded-xl px-4 py-2.5 text-sm font-medium border border-themed"
      style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}
    >
      <option value="">All Properties</option>
      {properties.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  )
}
