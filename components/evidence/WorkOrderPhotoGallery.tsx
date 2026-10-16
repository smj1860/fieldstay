import type { WorkOrderEvidence, WorkOrderEvidencePhoto } from '@/lib/evidence/work-order-evidence'

function formatCaptured(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function Group({ title, photos, empty }: Readonly<{ title: string; photos: readonly WorkOrderEvidencePhoto[]; empty: string }>) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</h2>
      {photos.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{empty}</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {photos.map((p) => (
            <figure key={p.id} className="card p-2 space-y-1">
              {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not optimizable */}
              <img src={p.url} alt={`${title} capture`} className="w-full h-40 object-cover rounded" loading="lazy" />
              <figcaption className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {formatCaptured(p.capturedAt)}
                {p.hashVerified ? ' · Verified' : ''}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * Before and after photographs for one work order. Pure presentation: the
 * caller has already decided this audience may see this work order, and the
 * URLs it holds are 5 minute signed links (see lib/evidence/work-order-evidence.ts).
 */
export function WorkOrderPhotoGallery({ evidence }: Readonly<{ evidence: WorkOrderEvidence }>) {
  return (
    <div className="space-y-6">
      <Group title="Before" photos={evidence.before} empty="No photos were recorded before the work." />
      <Group title="After" photos={evidence.after} empty="No photos were recorded after the work." />
    </div>
  )
}
