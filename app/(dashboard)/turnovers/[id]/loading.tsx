export default function Loading() {
  return (
    <div className="max-w-3xl animate-pulse">
      {/* Back link */}
      <div className="h-4 w-32 rounded bg-raised-themed mb-5" />

      {/* Header: property name + city, priority/status badges */}
      <div className="flex items-start justify-between mb-6">
        <div className="space-y-2">
          <div className="h-6 w-56 rounded bg-raised-themed" />
          <div className="h-3.5 w-32 rounded bg-raised-themed" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-6 w-24 rounded-full bg-raised-themed" />
          <div className="h-6 w-24 rounded-full bg-raised-themed" />
        </div>
      </div>

      {/* Timing + Assignment cards */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="card space-y-3">
          <div className="h-4 w-16 rounded bg-raised-themed" />
          <div className="h-3.5 w-20 rounded bg-raised-themed" />
          <div className="h-4 w-32 rounded bg-raised-themed" />
          <div className="h-3.5 w-24 rounded bg-raised-themed" />
          <div className="h-4 w-32 rounded bg-raised-themed" />
        </div>
        <div className="card space-y-3">
          <div className="h-4 w-24 rounded bg-raised-themed" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-raised-themed flex-shrink-0" />
            <div className="space-y-1.5">
              <div className="h-3.5 w-28 rounded bg-raised-themed" />
              <div className="h-3 w-20 rounded bg-raised-themed" />
            </div>
          </div>
        </div>
      </div>

      {/* Checklist card */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="h-4 w-40 rounded bg-raised-themed" />
          <div className="h-4 w-24 rounded bg-raised-themed" />
        </div>
        <div className="space-y-4">
          {[0, 1, 2].map((section) => (
            <div key={section}>
              <div className="h-3 w-24 rounded bg-raised-themed mb-2" />
              <div className="space-y-1.5">
                {[0, 1, 2].map((item) => (
                  <div key={item} className="h-8 rounded-lg bg-raised-themed" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
