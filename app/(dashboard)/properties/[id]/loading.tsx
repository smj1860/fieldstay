export default function Loading() {
  return (
    <div className="max-w-3xl animate-pulse">
      {/* Breadcrumb + header */}
      <div className="flex items-start justify-between mb-8">
        <div className="space-y-2">
          <div className="h-3.5 w-40 rounded bg-raised-themed" />
          <div className="h-6 w-56 rounded bg-raised-themed" />
          <div className="h-3.5 w-44 rounded bg-raised-themed" />
        </div>
        <div className="h-9 w-24 rounded-lg bg-raised-themed" />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="card space-y-2">
          <div className="h-5 w-5 rounded bg-raised-themed" />
          <div className="h-6 w-10 rounded bg-raised-themed" />
          <div className="h-3 w-20 rounded bg-raised-themed" />
        </div>
        <div className="card space-y-2">
          <div className="h-5 w-5 rounded bg-raised-themed" />
          <div className="h-6 w-10 rounded bg-raised-themed" />
          <div className="h-3 w-20 rounded bg-raised-themed" />
        </div>
        <div className="card space-y-2">
          <div className="h-5 w-5 rounded bg-raised-themed" />
          <div className="h-6 w-10 rounded bg-raised-themed" />
          <div className="h-3 w-20 rounded bg-raised-themed" />
        </div>
      </div>

      {/* Property details */}
      <div className="card mb-4 space-y-4">
        <div className="h-4 w-32 rounded bg-raised-themed" />
        <div className="grid grid-cols-2 gap-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-3.5 w-28 rounded bg-raised-themed" />
          ))}
        </div>
      </div>

      {/* Maintenance schedule manager */}
      <div className="card mb-4 space-y-3">
        <div className="h-4 w-48 rounded bg-raised-themed" />
        <div className="h-20 rounded-lg bg-raised-themed" />
      </div>

      {/* Maintenance history */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="h-4 w-28 rounded bg-raised-themed" />
          <div className="h-3 w-16 rounded bg-raised-themed" />
        </div>
        <div className="flex items-center gap-6 mb-5 pb-4 border-b border-themed">
          <div className="space-y-1.5">
            <div className="h-3 w-16 rounded bg-raised-themed" />
            <div className="h-6 w-14 rounded bg-raised-themed" />
          </div>
          <div className="space-y-1.5">
            <div className="h-3 w-20 rounded bg-raised-themed" />
            <div className="h-6 w-10 rounded bg-raised-themed" />
          </div>
        </div>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-9 rounded-lg bg-raised-themed" />
          ))}
        </div>
      </div>

      {/* Vendor invoices */}
      <div className="card mb-4 space-y-3">
        <div className="h-4 w-32 rounded bg-raised-themed" />
        <div className="h-16 rounded-lg bg-raised-themed" />
      </div>

      {/* Calendar feeds */}
      <div className="card space-y-3">
        <div className="h-4 w-32 rounded bg-raised-themed" />
        <div className="h-8 rounded-lg bg-raised-themed" />
      </div>
    </div>
  )
}
