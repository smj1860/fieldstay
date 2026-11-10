import Link from 'next/link'

import { isOwnerRezOfferActive } from '@/app/ownerrez/launch-offer'

/**
 * Homepage-only bar routing OwnerRez users to /ownerrez during the launch offer.
 * Expires with the offer (see launch-offer.ts). Remove in the January cleanup PR
 * together with the /ownerrez banner.
 */
export default function OwnerRezLaunchBar() {
  if (!isOwnerRezOfferActive()) return null

  return (
    <Link
      href="/ownerrez"
      className="block px-4 py-2 text-center text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-[var(--mkt-gold)]"
      style={{ background: 'var(--mkt-ed-ink)', color: 'var(--mkt-ed-on-ink-strong)' }}
      aria-label="FieldStay is now an official OwnerRez integration partner. See the OwnerRez launch offer."
    >
      <span>FieldStay is now an official OwnerRez integration partner.</span>{' '}
      <span className="hidden sm:inline">OwnerRez users get 50% off through the end of December.</span>{' '}
      <span className="underline" style={{ color: 'var(--mkt-gold)' }}>See the offer</span>
    </Link>
  )
}
