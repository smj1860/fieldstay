import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Privacy Policy — FieldStay' }

const EFFECTIVE_DATE = 'June 1, 2026'

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 mb-8 inline-block">
          ← Back to FieldStay
        </Link>

        <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-10">Effective: {EFFECTIVE_DATE}</p>

        <div className="prose prose-gray max-w-none space-y-8 text-gray-700">

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. Who We Are</h2>
            <p>
              FieldStay (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) is a field operations
              platform for short-term rental property managers. This policy explains how we collect, use,
              and protect your information when you use FieldStay (&ldquo;Service&rdquo;).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. Information We Collect</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Account data:</strong> name, email address, and password (hashed) when you create an account.</li>
              <li><strong>Organization data:</strong> property details, booking data, crew and team information you enter into the Service.</li>
              <li><strong>Integration data:</strong> OAuth tokens for connected platforms (e.g., OwnerRez) stored encrypted in Supabase Vault.</li>
              <li><strong>Usage data:</strong> pages visited, features used, and error logs collected to improve the Service.</li>
              <li><strong>Payment data:</strong> billing information is processed directly by Stripe. We store only your Stripe customer ID.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. How We Use Your Information</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>To provide, operate, and improve the Service.</li>
              <li>To send transactional emails (invites, work orders, billing receipts).</li>
              <li>To sync reservation data from connected integrations.</li>
              <li>To comply with legal obligations and enforce our Terms of Service.</li>
            </ul>
            <p className="mt-3">We do not sell your personal data to third parties.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. Cookies and Local Storage</h2>
            <p>
              Session cookies are set automatically as a technical necessity to keep you logged in.
              They are not used for advertising or tracking and do not require consent under GDPR or CPRA.
              We also use <code className="bg-gray-100 px-1 rounded text-sm">localStorage</code> to remember
              your theme preference. No advertising or cross-site tracking cookies are used.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. Data Sharing</h2>
            <p>We share data only with:</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li><strong>Supabase</strong> — database and authentication infrastructure.</li>
              <li><strong>Stripe</strong> — payment processing.</li>
              <li><strong>Resend</strong> — transactional email delivery.</li>
              <li><strong>Vercel</strong> — application hosting.</li>
              <li><strong>Anthropic</strong> — AI-powered response generation (RepuGuard feature only, review text transmitted).</li>
              <li><strong>OwnerRez</strong> — reservation data sync when you connect your account.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">6. Sub-Processors &amp; Data Storage</h2>
            <p className="mb-3">
              FieldStay uses the following third-party services to operate the platform. Each acts as a
              data processor on our behalf:
            </p>
            <dl className="space-y-4">
              <div>
                <dt className="font-semibold text-gray-800">Supabase, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">
                  Database and authentication. Your data is stored on servers operated by Supabase in
                  the United States (us-east-1 region). Supabase is certified under the EU-US Data
                  Privacy Framework, which provides an adequate level of protection for personal data
                  transferred from the European Union to the United States.{' '}
                  <a href="https://supabase.com/privacy" className="underline" target="_blank" rel="noopener noreferrer">
                    Learn more
                  </a>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Stripe, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">
                  Payment processing. Stripe is PCI DSS compliant and certified under the EU-US Data
                  Privacy Framework.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Resend, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">Transactional email delivery.</dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Anthropic, PBC (United States)</dt>
                <dd className="text-sm mt-0.5">
                  AI-powered review response generation (RepuGuard feature). Review text is processed
                  to generate responses and is not retained by Anthropic beyond the duration of the
                  API call.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Inngest, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">Background job orchestration.</dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Vercel, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">Application hosting and delivery.</dd>
              </div>
            </dl>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">7. Your Rights (GDPR / CPRA)</h2>
            <p>Depending on your jurisdiction, you may have the right to:</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>Access the personal data we hold about you.</li>
              <li>Correct inaccurate personal data.</li>
              <li>Delete your account and associated personal data.</li>
              <li>Export your data in a portable format.</li>
              <li>Object to or restrict certain processing.</li>
            </ul>
            <p className="mt-3">
              To exercise these rights, use the account deletion feature in{' '}
              <strong>Settings → Account</strong> or contact us at{' '}
              <a href="mailto:privacy@fieldstay.app" className="underline">privacy@fieldstay.app</a>.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">8. Data Retention</h2>
            <p>
              We retain your data for as long as your account is active. When you delete your account,
              we delete your personal data within 30 days, except where retention is required by law
              (e.g., billing records for 7 years).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">9. Security</h2>
            <p>
              We use industry-standard measures including TLS encryption in transit, AES-256 encryption
              at rest for sensitive tokens, row-level security on all database tables, and role-based
              access controls.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">10. Contact</h2>
            <p>
              Questions about this policy? Email{' '}
              <a href="mailto:privacy@fieldstay.app" className="underline">privacy@fieldstay.app</a>.
            </p>
          </section>

        </div>
      </div>
    </div>
  )
}
