export default function Loading() {
  return (
    <div className="max-w-6xl animate-pulse space-y-4">
      <div className="h-6 w-40 rounded bg-raised-themed" />
      <div className="grid gap-6 md:grid-cols-[320px_1fr]">
        <div className="card h-64" />
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => <div key={i} className="card h-48" />)}
        </div>
      </div>
    </div>
  )
}
