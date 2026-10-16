export interface PriorPhoto {
  id:         string
  url:        string
  capturedAt: string
}

/**
 * The property manager's photographs of the problem, shown to the vendor before
 * they start. Read-only and sealed: these are the "before" record, so there is
 * no upload or delete control here. Renders nothing when there are none.
 */
export function PriorPhotosPanel({ photos }: Readonly<{ photos: readonly PriorPhoto[] }>) {
  if (photos.length === 0) return null
  return (
    <section className="card space-y-2" aria-label="Photos from the property manager">
      <h2 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Photos from the property manager</h2>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        These were taken before the work. They are shown so everyone starts from the same picture.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {photos.map((p) => (
          <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="block focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)] rounded">
            {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not optimizable */}
            <img src={p.url} alt="Property manager view of the problem before the work" className="w-full h-32 object-cover rounded" loading="lazy" />
          </a>
        ))}
      </div>
    </section>
  )
}
