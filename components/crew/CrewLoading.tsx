import { Loader2 } from 'lucide-react'

/** Shared loading indicator for crew PWA pages — replaces the previously
 *  inconsistent per-page treatments (spinner-only, plain unstyled text,
 *  or nothing at all) with one centered spinner + label. */
export function CrewLoading({ label = 'Loading…' }: Readonly<{ label?: string }>) {
  return (
    <div className="text-center py-20 text-muted-themed">
      <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
      <p className="text-sm">{label}</p>
    </div>
  )
}
