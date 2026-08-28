import Link from 'next/link'
import { AlertCircle } from 'lucide-react'
import { buttonVariantClass } from '@/components/ui/Button'

/**
 * In-app countdown for the last days of the free trial.
 *
 * NOT built on NudgeBanner, deliberately. That component is dismissible and
 * persists the dismissal in localStorage under a static id — so a PM who
 * closed "3 days left" would never see "1 day left" either, and would lose
 * access to the dashboard with no warning they had not already waved away.
 * A nudge is optional; losing your account tomorrow is not.
 *
 * This exists because the WARNING EMAIL never sent. `billing/trial-lifecycle-start`
 * had exactly one sender — the Stripe webhook, gated on a Stripe-side trial —
 * and FieldStay's trial is a local timestamp written at signup with no Stripe
 * subscription behind it, so the condition could never be true and the
 * sequence never ran for any org in the product's history. That is fixed at
 * the signup path now, but a channel that depends on email delivery, a
 * correct address, and an Inngest sleep surviving 11 days is not a channel to
 * have only one of. This one is rendered from the dashboard layout on every
 * navigation and depends on nothing but the org row.
 */
export function TrialCountdownBanner({
  daysLeft,
}: Readonly<{ daysLeft: number }>) {
  const finalDay = daysLeft <= 1
  const accent   = finalDay ? 'var(--accent-red)' : 'var(--accent-amber)'

  // "today" rather than "in 1 day": at this point the account stops working
  // during the current working day, and a PM reading "1 day" reasonably plans
  // to deal with it tomorrow.
  const remaining = finalDay
    ? 'Your free trial ends today'
    : `Your free trial ends in ${daysLeft} days`

  return (
    <div
      className="rounded-xl px-5 py-4 mb-6 flex items-center justify-between gap-4 flex-wrap"
      style={{
        background: finalDay ? 'var(--accent-red-dim)' : 'var(--accent-amber-dim)',
        border:     `1px solid ${accent}`,
      }}
    >
      <div className="flex items-center gap-3">
        <AlertCircle className="w-5 h-5 flex-shrink-0" style={{ color: accent }} />
        <div>
          <p className="text-sm font-semibold" style={{ color: accent }}>
            {remaining}
          </p>
          <p className="text-xs text-muted-themed mt-0.5">
            Choose a plan to keep your properties, turnovers and crew scheduling active.
          </p>
        </div>
      </div>
      <Link
        href="/settings?tab=Billing"
        className={buttonVariantClass('primary') + ' text-sm flex-shrink-0'}
      >
        Choose a plan
      </Link>
    </div>
  )
}
