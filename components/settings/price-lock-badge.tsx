import { Badge } from '@/components/ui/Badge'
import type { HospitablePromoStatus } from '@/lib/queries/hospitable-promo'

interface Props {
  promo: HospitablePromoStatus | null
}

/**
 * Numbered badge for the tier-1 (2-year) lock; plain "N-Year" badge for the
 * tier-2 (1-year) lock, which has no sequence number by design (see
 * hospitable_launch_promo.price_lock_sequence).
 */
export function PriceLockBadge({ promo }: Readonly<Props>) {
  if (!promo?.priceLockActive) return null

  const expiresLabel = promo.priceLockExpiresAt
    ? new Date(promo.priceLockExpiresAt).toLocaleDateString('en-US', {
        year:  'numeric',
        month: 'long',
        day:   'numeric',
      })
    : null

  const label = promo.priceLockSequence
    ? `Price Lock #${promo.priceLockSequence} of 100`
    : `${promo.priceLockYears ?? 1}-Year Price Lock`

  return (
    <Badge tone="gold" className="text-sm px-3 py-1">
      <span aria-hidden>🔒</span>
      {label}
      {expiresLabel ? ` — locked through ${expiresLabel}` : ''}
    </Badge>
  )
}
