// Renders inside layout.tsx's white card, so this is just the inner content
// skeleton (step indicator + form fields) — no full-page wrapper here.
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="flex items-center gap-2 mb-6">
        <div className="w-6 h-6 rounded-full flex-shrink-0" style={{ background: 'var(--bg-raised)' }} />
        <div className="h-4 w-32 rounded" style={{ background: 'var(--bg-raised)' }} />
        <div className="flex-1 h-px mx-1" style={{ background: 'var(--border)' }} />
        <div className="w-6 h-6 rounded-full flex-shrink-0" style={{ background: 'var(--bg-raised)' }} />
        <div className="h-4 w-28 rounded" style={{ background: 'var(--bg-raised)' }} />
      </div>

      <div className="h-6 w-56 rounded mb-2" style={{ background: 'var(--bg-raised)' }} />
      <div className="h-4 w-72 rounded mb-6" style={{ background: 'var(--bg-raised)' }} />

      <div className="space-y-4">
        <div className="h-11 rounded-xl" style={{ background: 'var(--bg-raised)' }} />
        <div className="h-11 rounded-xl" style={{ background: 'var(--bg-raised)' }} />
      </div>
    </div>
  )
}
