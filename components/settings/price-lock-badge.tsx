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
    <div
      className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium"
      style={{
        border:     '1px solid var(--accent-gold)',
        background: 'var(--accent-amber-dim)',
        color:      'var(--accent-amber)',
      }}
    >
      <span aria-hidden>🔒</span>
      <span>
        {label}
        {expiresLabel ? ` — locked through ${expiresLabel}` : ''}
      </span>
    </div>
  )
}
