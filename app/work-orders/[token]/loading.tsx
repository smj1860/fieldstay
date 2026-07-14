export default function Loading() {
  return (
    <div className="min-h-screen bg-accent-50 flex items-center justify-center p-4">
      <div className="bg-card-themed rounded-2xl shadow-[0_4px_24px_0_rgba(0,0,0,.10)] w-full max-w-md p-8 animate-pulse">
        <div className="text-center mb-6">
          <div className="h-6 w-28 rounded bg-raised-themed mx-auto mb-2" />
          <div className="h-3 w-20 rounded bg-raised-themed mx-auto" />
        </div>
        <div className="space-y-3">
          <div className="h-5 w-3/4 rounded bg-raised-themed" />
          <div className="h-4 w-full rounded bg-raised-themed" />
          <div className="h-4 w-5/6 rounded bg-raised-themed" />
          <div className="h-24 rounded-lg bg-raised-themed" />
          <div className="h-10 rounded-lg bg-raised-themed" />
        </div>
      </div>
    </div>
  )
}
