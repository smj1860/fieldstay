export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-brand-800">
      <div className="w-full max-w-sm animate-pulse">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="h-7 w-32 rounded bg-brand-700 mx-auto" />
        </div>

        {/* Card */}
        <div className="rounded-2xl p-8 bg-white">
          <div className="flex flex-col items-center mb-6">
            <div className="w-12 h-12 rounded-full bg-accent-100 mb-3" />
            <div className="h-5 w-48 rounded bg-accent-100 mb-2" />
            <div className="h-4 w-36 rounded bg-accent-100" />
          </div>
          <div className="space-y-4">
            <div className="h-11 rounded-xl bg-accent-100" />
            <div className="h-11 rounded-xl bg-accent-100" />
            <div className="h-11 rounded-xl bg-accent-100" />
          </div>
        </div>
      </div>
    </div>
  )
}
