import { Card } from '@/components/ui/Card'

interface QueryErrorStateProps {
  /** What could not be loaded, lowercase noun phrase — e.g. "vendors", "this month's ledger". */
  label: string
  className?: string
}

/**
 * Renders when a Supabase read FAILED, as opposed to returning zero rows.
 * The distinction matters: an empty state tells the PM "you have nothing
 * here yet", which is an outright lie during an RLS/GRANT/network outage and
 * hides the incident. Use this wherever a failed read should degrade one
 * section instead of throwing to the segment's error.tsx.
 */
export function QueryErrorState({ label, className = '' }: Readonly<QueryErrorStateProps>) {
  return (
    <Card className={`text-center py-8 ${className}`} role="alert">
      <p className="font-semibold mb-1" style={{ color: 'var(--accent-red)' }}>
        Couldn&apos;t load {label}.
      </p>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        This is a problem on our end, not an empty list — it has been logged.
        Refresh to try again.
      </p>
    </Card>
  )
}
