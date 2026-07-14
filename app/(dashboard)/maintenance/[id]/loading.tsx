export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto animate-pulse">
      {/* Back link */}
      <div className="h-4 w-28 rounded bg-raised-themed mb-5" />

      {/* Work order "document" card */}
      <div className="card">
        {/* Document header: brand/title left, WO number right */}
        <div className="flex items-start justify-between pb-5 mb-5 border-b border-themed">
          <div className="space-y-1.5">
            <div className="h-3 w-20 rounded bg-raised-themed" />
            <div className="h-5 w-32 rounded bg-raised-themed" />
          </div>
          <div className="space-y-1.5 flex flex-col items-end">
            <div className="h-5 w-24 rounded bg-raised-themed" />
            <div className="h-3 w-28 rounded bg-raised-themed" />
          </div>
        </div>

        {/* Info grid: property + vendor/schedule */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <div className="space-y-2">
            <div className="h-3 w-16 rounded bg-raised-themed" />
            <div className="h-4 w-40 rounded bg-raised-themed" />
            <div className="h-3.5 w-32 rounded bg-raised-themed" />
          </div>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="h-3 w-20 rounded bg-raised-themed" />
              <div className="h-4 w-36 rounded bg-raised-themed" />
            </div>
            <div className="space-y-2">
              <div className="h-3 w-16 rounded bg-raised-themed" />
              <div className="h-4 w-28 rounded bg-raised-themed" />
            </div>
          </div>
        </div>

        {/* Status strip */}
        <div className="h-10 rounded-lg bg-raised-themed mb-6" />

        {/* Line items / notes blocks */}
        <div className="space-y-3 mb-6">
          <div className="h-3 w-24 rounded bg-raised-themed" />
          <div className="h-24 rounded-lg bg-raised-themed" />
        </div>
        <div className="space-y-3">
          <div className="h-3 w-20 rounded bg-raised-themed" />
          <div className="h-16 rounded-lg bg-raised-themed" />
        </div>
      </div>
    </div>
  )
}
