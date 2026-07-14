export default function Loading() {
  return (
    <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md animate-pulse">
        <div className="text-center mb-8">
          <div className="h-8 w-36 rounded bg-brand-700 mx-auto mb-2" />
          <div className="h-4 w-20 rounded bg-brand-700 mx-auto" />
        </div>
        <div className="bg-card-themed rounded-2xl shadow-lg p-8">
          <div className="h-6 w-48 rounded bg-raised-themed mb-2" />
          <div className="h-4 w-64 rounded bg-raised-themed mb-6" />
          <div className="space-y-4">
            <div className="h-11 rounded-xl bg-raised-themed" />
            <div className="h-11 rounded-xl bg-raised-themed" />
            <div className="h-11 rounded-xl bg-raised-themed" />
          </div>
        </div>
      </div>
    </div>
  )
}
