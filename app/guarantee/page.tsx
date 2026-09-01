import type { Metadata } from 'next'
import Link from 'next/link'

import { marketingUrl } from '@/lib/marketing'
import {
  GUARANTEE_NAME,
  GUARANTEE_SCOPE_LINE,
  RESPONSE_WINDOW_BUSINESS_DAYS,
  COVERED_PERIOD_MONTHS,
  CLAIM_WINDOW_DAYS,
  CREDITS_PER_BILLING_PERIOD,
  CHANGE_NOTICE_DAYS,
  GUARANTEE_EMAIL,
} from '@/lib/guarantee'

// Suffix omitted deliberately: app/layout.tsx applies
// `template: '%s — FieldStay'` — see app/dpa/page.tsx's identical note.
export const metadata: Metadata = {
  title:       GUARANTEE_NAME,
  description: `${GUARANTEE_SCOPE_LINE} If FieldStay cannot produce the record of what happened on a job, that billing period is credited.`,
  alternates:  { canonical: marketingUrl('/guarantee') },
}

const LAST_UPDATED = 'September 1, 2026'

export default function GuaranteePage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2" style={{ color: 'var(--mkt-ink)' }}>{GUARANTEE_NAME}</h1>
        <p className="text-sm mb-2" style={{ color: 'var(--mkt-muted)' }}>Last updated: {LAST_UPDATED}</p>
        <p className="text-base mb-10 font-medium" style={{ color: 'var(--mkt-muted-strong)' }}>{GUARANTEE_SCOPE_LINE}</p>

        <div className="prose max-w-none space-y-10" style={{ color: 'var(--mkt-muted-strong)' }}>

          {/* ── §1. What this guarantee covers ────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold mb-3" style={{ color: 'var(--mkt-ink)' }}>1. What this guarantee covers</h2>
            <p className="text-sm mb-3">
              FieldStay logs every checklist step, synced photo, and work order status change as it
              happens. If you ask what happened on a job and FieldStay cannot produce that record, the
              billing period the request falls in is credited — up to {CREDITS_PER_BILLING_PERIOD} credit
              per billing period.
            </p>
            <div className="rounded-lg border p-4 my-4" style={{ borderColor: 'var(--mkt-border)' }}>
              <dl className="text-sm space-y-1">
                <div className="flex justify-between gap-4">
                  <dt className="font-semibold" style={{ color: 'var(--mkt-ink)' }}>Captured by FieldStay?</dt>
                  <dd>Guarantee applies</dd>
                </div>
                <div className="border-t pt-1 flex justify-between gap-4" style={{ borderColor: 'var(--mkt-border)' }}>
                  <dt>Crew signed in, worked in the app offline, work queued on the device and never reached us</dt>
                  <dd className="font-semibold whitespace-nowrap" style={{ color: 'var(--mkt-ink)' }}>Record Failure</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Crew never opened the app; work done on paper, by text, or in another system</dt>
                  <dd className="whitespace-nowrap">Not covered</dd>
                </div>
              </dl>
            </div>
            <p className="text-sm mb-3">
              <strong>1a. &ldquo;Captured by FieldStay&rdquo;</strong> means an action entered into the
              FieldStay web or mobile application on a device signed in to your account, whether or not
              that device had network connectivity at the time. Where it is genuinely unclear whether an
              action was Captured, FieldStay resolves that ambiguity in your favor.
            </p>
          </section>

          {/* ── §2. What is not covered ──────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold mb-3" style={{ color: 'var(--mkt-ink)' }}>2. What is not covered</h2>
            <p className="text-sm mb-3">
              Work that was never entered into FieldStay in the first place — done on paper, by text, or
              in another system — is not a Record Failure, because there is nothing FieldStay could have
              recorded.
            </p>
            <p className="text-sm">
              During any period your account is suspended for non-payment, access to the Service is
              disabled and no operational records are created — actions that would have happened during a
              suspension are not covered. FieldStay does not delete your data because of a suspension
              alone; records created before the suspension remain available afterward, subject to our
              normal retention periods.
            </p>
          </section>

          {/* ── §3. Filing a claim ──────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold mb-3" style={{ color: 'var(--mkt-ink)' }}>3. Filing a claim</h2>
            <p className="text-sm mb-3">
              Email{' '}
              <a href={`mailto:${GUARANTEE_EMAIL}`} className="underline" style={{ color: 'var(--mkt-ink)' }}>
                {GUARANTEE_EMAIL}
              </a>{' '}
              with what happened and when. FieldStay responds within {RESPONSE_WINDOW_BUSINESS_DAYS} business
              days with the record if one exists, or confirmation that it does not.
            </p>
            <p className="text-sm mb-3">
              A claim must be filed within {CLAIM_WINDOW_DAYS} days of the event it concerns, and the
              event itself must fall within the {COVERED_PERIOD_MONTHS}-month period preceding the claim.
            </p>
          </section>

          {/* ── §4. The remedy ────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold mb-3" style={{ color: 'var(--mkt-ink)' }}>4. The remedy</h2>
            <p className="text-sm mb-3">
              A confirmed Record Failure credits the billing period it falls in, up to{' '}
              {CREDITS_PER_BILLING_PERIOD} credit per billing period however many Record Failures are
              found in it. This credit is the sole remedy under this guarantee.
            </p>
          </section>

          {/* ── §5. Changes to this guarantee ─────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold mb-3" style={{ color: 'var(--mkt-ink)' }}>5. Changes to this guarantee</h2>
            <p className="text-sm">
              FieldStay will give at least {CHANGE_NOTICE_DAYS} days&apos; notice by email before
              narrowing or ending this guarantee. This guarantee is incorporated into, and governed
              alongside, the FieldStay{' '}
              <Link href="/terms" className="underline" style={{ color: 'var(--mkt-ink)' }}>Terms of Service</Link>.
            </p>
          </section>

        </div>

        <div className="mt-12 pt-6 border-t" style={{ borderColor: 'var(--mkt-border)' }}>
          <Link href="/pricing" className="text-sm hover:text-[var(--mkt-muted-strong)]" style={{ color: 'var(--mkt-muted)' }}>
            ← Back to pricing
          </Link>
        </div>
      </div>
    </div>
  )
}
