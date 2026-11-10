import Link from 'next/link'
import { OWNERREZ_URL, OWNERREZ_PROMO_CODE } from './launch-offer'

/**
 * Partnership launch banner. The caller decides whether to render it
 * (isOwnerRezOfferActive); the page revalidates hourly so the date check
 * re-runs after the offer ends. Delete this file in the January cleanup PR.
 */
export function OwnerRezLaunchBanner() {
  return (
    <div className="mt-6 mb-10 bg-brand-panel border border-brand-panelBorder rounded-2xl px-6 py-6 text-center">
      <p className="text-xs font-semibold tracking-widest uppercase mb-2" style={{ color: 'var(--mkt-gold)' }}>
        New partnership
      </p>
      <h2 className="text-2xl font-bold leading-snug font-display mb-2" style={{ color: 'var(--mkt-ed-on-ink-strong)' }}>
        FieldStay is now a full integration partner with{' '}
        <a
          href={OWNERREZ_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:no-underline"
        >
          OwnerRez
        </a>
      </h2>
      <p className="mb-2" style={{ color: 'var(--mkt-on-dark-softer)' }}>
        To celebrate, OwnerRez users get 50% off FieldStay through the end of December.
      </p>
      <p className="mb-5" style={{ color: 'var(--mkt-on-dark-softer)' }}>
        Use code{' '}
        <code className="font-mono font-bold bg-brand-800 px-2 py-0.5 rounded select-all" style={{ color: 'var(--mkt-gold)' }}>
          {OWNERREZ_PROMO_CODE}
        </code>{' '}
        at checkout.
      </p>
      <Link
        href="/signup?provider=ownerrez&next=/onboarding"
        className="inline-block font-bold px-8 py-3 rounded-xl hover:opacity-90 transition-opacity"
        style={{ background: 'var(--mkt-gold)', color: 'var(--mkt-ink)' }}
      >
        Start your free trial
      </Link>
    </div>
  )
}
