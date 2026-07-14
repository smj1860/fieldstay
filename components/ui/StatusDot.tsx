export type StatusDotStatus = 'good' | 'warning' | 'critical' | 'attention' | 'offline' | 'unknown'
type Status = StatusDotStatus

const toneClass: Record<Status, string> = {
  good:      'bg-[var(--accent-green)]',
  warning:   'bg-[var(--accent-amber)]',
  critical:  'bg-[var(--accent-red)]',
  attention: 'bg-[var(--accent-amber)]',
  offline:   'bg-[var(--text-muted)]',
  unknown:   'bg-[var(--border-strong)]',
}

export function StatusDot({ status, label }: Readonly<{ status: Status; label: string }>) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${toneClass[status]}`} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  )
}
