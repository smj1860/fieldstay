export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">
            FieldStay
          </h1>
          <p className="text-brand-200 text-sm mt-1">
            STR operations, handled.
          </p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-card-lg p-8">
          {children}
        </div>
      </div>
    </div>
  )
}
