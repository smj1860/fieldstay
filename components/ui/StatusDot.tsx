type Status = 'good' | 'warning' | 'critical' | 'attention' | 'offline' | 'unknown'

const toneClass: Record<Status, string> = {
  good:      'bg-[var(--accent-green)]',
  warning:   'bg-[var(--accent-amber)]',
  critical:  'bg-[var(--accent-red)]',
  attention: 'bg-orange-500',
  offline:   'bg-neutral-500',
  unknown:   'bg-neutral-300',
}

export function StatusDot({ status, label }: Readonly<{ status: Status; label: string }>) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${toneClass[status]}`} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  )
}
