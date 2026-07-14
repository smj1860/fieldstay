// No layout.tsx wraps this route, so the skeleton reproduces page.tsx's own
// full-page card shell (var(--bg-base) / var(--bg-card)) rather than relying
// on a parent layout to provide it.
export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--bg-base)' }}>
      <div
        className="w-full max-w-md rounded-2xl p-8 text-center animate-pulse"
        style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg)' }}
      >
        <div className="h-7 w-32 rounded mx-auto mb-6" style={{ background: 'var(--bg-raised)' }} />
        <div className="h-5 w-48 rounded mx-auto mb-2" style={{ background: 'var(--bg-raised)' }} />
        <div className="h-4 w-64 rounded mx-auto mb-8" style={{ background: 'var(--bg-raised)' }} />
        <div className="space-y-3">
          <div className="h-11 rounded-xl" style={{ background: 'var(--bg-raised)' }} />
          <div className="h-4 w-40 rounded mx-auto" style={{ background: 'var(--bg-raised)' }} />
        </div>
      </div>
    </div>
  )
}
