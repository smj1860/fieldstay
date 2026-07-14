export default function Loading() {
  return (
    <div className="min-h-screen bg-canvas-themed">
      {/* Header */}
      <div className="bg-card-themed border-b border-themed">
        <div className="max-w-4xl mx-auto px-4 py-5 sm:px-6 animate-pulse">
          <div className="h-3 w-40 rounded bg-raised-themed mb-2" />
          <div className="h-7 w-56 rounded bg-raised-themed" />
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8 sm:px-6 space-y-6 animate-pulse">
        {/* Month filter pills */}
        <div className="flex gap-2">
          <div className="h-8 w-24 rounded-lg bg-raised-themed" />
          <div className="h-8 w-24 rounded-lg bg-raised-themed" />
          <div className="h-8 w-24 rounded-lg bg-raised-themed" />
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="h-20 rounded-xl bg-raised-themed" />
          <div className="h-20 rounded-xl bg-raised-themed" />
          <div className="h-20 rounded-xl bg-raised-themed" />
        </div>

        {/* Occupancy */}
        <div className="h-28 rounded-xl bg-raised-themed" />

        {/* Transaction list */}
        <div className="space-y-2">
          <div className="h-14 rounded-lg bg-raised-themed" />
          <div className="h-14 rounded-lg bg-raised-themed" />
          <div className="h-14 rounded-lg bg-raised-themed" />
        </div>
      </div>
    </div>
  )
}
