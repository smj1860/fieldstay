import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Terms of Service — FieldStay' }

const EFFECTIVE_DATE = 'June 1, 2026'

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 mb-8 inline-block">
          ← Back to FieldStay
        </Link>

        <h1 className="text-3xl font-bold text-gray-900 mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-10">Effective: {EFFECTIVE_DATE}</p>

        <div className="prose prose-gray max-w-none space-y-8 text-gray-700">

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. Acceptance</h2>
            <p>
              By accessing or using FieldStay (&ldquo;Service&rdquo;), you agree to be bound by these
              Terms. If you do not agree, do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. Description of Service</h2>
            <p>
              FieldStay is a field operations platform for short-term rental property managers. Features
              include turnover scheduling, crew management, inventory tracking, work order management,
              owner portal reporting, and AI-powered review response generation (RepuGuard).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. Account Registration</h2>
            <p>
              You must provide accurate and complete information when creating an account. You are
              responsible for all activity under your account and must keep your credentials confidential.
              You must be at least 18 years old to use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. Subscriptions and Billing</h2>
            <p>
              Paid plans are billed monthly or annually through Stripe. Prices are subject to change
              with 30 days&rsquo; notice. Free trials do not require a credit card. Cancellations take
              effect at the end of the current billing period. No refunds are issued for partial periods
              except where required by law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. Acceptable Use</h2>
            <p>You may not use the Service to:</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>Violate any applicable law or regulation.</li>
              <li>Transmit malware, spam, or abusive content.</li>
              <li>Attempt to gain unauthorized access to any system or data.</li>
              <li>Reverse-engineer, decompile, or create derivative works of the Service.</li>
              <li>Resell or sublicense access to the Service without our written consent.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">6. Your Data</h2>
            <p>
              You retain ownership of all data you upload or create in the Service. You grant us a
              limited license to store, process, and display your data solely to operate the Service.
              See our <Link href="/privacy" className="underline">Privacy Policy</Link> for details on
              how we handle your data.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">7. AI-Generated Content (RepuGuard)</h2>
            <p>
              RepuGuard uses AI to draft responses to guest reviews. AI-generated content is provided
              for review and editing only. You are solely responsible for any content you publish.
              FieldStay makes no warranty that AI-generated responses are accurate, appropriate, or
              legally compliant for your jurisdiction.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">8. Third-Party Integrations</h2>
            <p>
              The Service integrates with third-party platforms (e.g., OwnerRez, Stripe, Airbnb via
              iCal). Your use of those platforms is subject to their own terms. We are not responsible
              for third-party platform outages, data accuracy, or policy changes.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">9. Disclaimers</h2>
            <p>
              The Service is provided &ldquo;as is&rdquo; without warranty of any kind. We do not
              warrant that the Service will be uninterrupted, error-free, or meet your specific
              requirements.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">10. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, FieldStay&rsquo;s total liability for any claim
              arising from these Terms or the Service shall not exceed the amounts you paid us in the
              12 months preceding the claim. We are not liable for indirect, incidental, or consequential
              damages.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">11. Termination</h2>
            <p>
              You may delete your account at any time from Settings. We may suspend or terminate your
              account for violation of these Terms. Upon termination, your right to use the Service
              ceases immediately.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">12. Governing Law</h2>
            <p>
              These Terms are governed by the laws of the State of Delaware, without regard to conflict
              of law principles. Disputes shall be resolved through binding arbitration except where
              prohibited by law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">13. SMS Communications</h2>
            <p>
              By opting in to SMS communications from FieldStay, you agree to receive text messages
              related to your reservation including access codes, property information, and
              recommendations from your property manager. Message frequency varies by stay. Message
              and data rates may apply. Reply STOP to unsubscribe, HELP for support. For assistance
              contact <a href="mailto:help@fieldstay.app" className="underline">help@fieldstay.app</a>.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">14. Changes</h2>
            <p>
              We may update these Terms at any time. Continued use of the Service after changes
              constitutes acceptance. Material changes will be communicated by email or in-app notice.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">15. Contact</h2>
            <p>
              Questions?{' '}
              <a href="mailto:legal@fieldstay.app" className="underline">legal@fieldstay.app</a>
            </p>
          </section>

        </div>
      </div>
    </div>
  )
}
