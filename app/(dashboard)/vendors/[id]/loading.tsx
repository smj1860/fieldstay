export default function Loading() {
  return (
    <div className="max-w-3xl animate-pulse">
      {/* Breadcrumb */}
      <div className="h-3.5 w-32 rounded bg-raised-themed mb-6" />

      {/* Header: name + specialty, compliance badge + connect status */}
      <div className="flex items-start justify-between mb-6">
        <div className="space-y-2">
          <div className="h-6 w-48 rounded bg-raised-themed" />
          <div className="h-3.5 w-28 rounded bg-raised-themed" />
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="h-7 w-28 rounded-full bg-raised-themed" />
          <div className="h-5 w-20 rounded bg-raised-themed" />
        </div>
      </div>

      {/* Contact info */}
      <div className="card mb-4 space-y-4">
        <div className="h-4 w-28 rounded bg-raised-themed" />
        <div className="grid grid-cols-2 gap-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-3.5 w-28 rounded bg-raised-themed" />
          ))}
        </div>
      </div>

      {/* Work order stats */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="h-4 w-28 rounded bg-raised-themed" />
          <div className="h-3 w-14 rounded bg-raised-themed" />
        </div>
        <div className="flex gap-6 mb-4 pb-4 border-b border-themed">
          <div className="space-y-1.5">
            <div className="h-3 w-16 rounded bg-raised-themed" />
            <div className="h-6 w-10 rounded bg-raised-themed" />
          </div>
          <div className="space-y-1.5">
            <div className="h-3 w-20 rounded bg-raised-themed" />
            <div className="h-6 w-14 rounded bg-raised-themed" />
          </div>
        </div>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-9 rounded-lg bg-raised-themed" />
          ))}
        </div>
      </div>

      {/* Invoice history */}
      <div className="card mb-4 space-y-3">
        <div className="h-4 w-36 rounded bg-raised-themed" />
        <div className="h-16 rounded-lg bg-raised-themed" />
      </div>

      {/* Compliance documents */}
      <div className="card space-y-3">
        <div className="h-4 w-40 rounded bg-raised-themed" />
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-raised-themed" />
          ))}
        </div>
      </div>
    </div>
  )
}
