import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Privacy Policy — FieldStay' }

const EFFECTIVE_DATE  = 'June 9, 2026'
const CONTROLLER_NAME = 'FieldStay, Inc.'
const PRIVACY_EMAIL   = 'privacy@fieldstay.app'

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 mb-8 inline-block">
          ← Back to FieldStay
        </Link>

        <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-2">Effective: {EFFECTIVE_DATE}</p>
        <p className="text-sm text-gray-500 mb-10">
          For Data Processing Agreement (enterprise / GDPR Article 28):{' '}
          <Link href="/dpa" className="underline hover:text-gray-700">View DPA</Link>
        </p>

        <div className="prose prose-gray max-w-none space-y-10 text-gray-700">

          {/* ── 1. Controller Identity ─────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. Who We Are (Controller Identity)</h2>
            <p>
              {CONTROLLER_NAME} (&ldquo;FieldStay,&rdquo; &ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) is
              the data controller for personal information processed through the FieldStay platform
              (&ldquo;Service&rdquo;) — a field operations and property management system for short-term
              rental managers.
            </p>
            <p className="mt-3">
              <strong>Contact:</strong>{' '}
              <a href={`mailto:${PRIVACY_EMAIL}`} className="underline">{PRIVACY_EMAIL}</a>
            </p>
            <p className="mt-2 text-sm text-gray-500">
              FieldStay has not appointed a Data Protection Officer (DPO) because it does not engage in
              large-scale systematic processing of special categories of personal data as described in
              GDPR Article 37. If you are in the EU/EEA and wish to contact us about data protection
              matters, please use the email above.
            </p>
          </section>

          {/* ── 2. Personal Data We Collect ──────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. Personal Data We Collect</h2>
            <p className="mb-3">We collect the following categories of personal information:</p>
            <dl className="space-y-4">
              <div>
                <dt className="font-semibold text-gray-800">Identity and Contact Data</dt>
                <dd className="text-sm mt-0.5">
                  Name, email address, and profile photo (optional) when you create an account.
                  Phone numbers you voluntarily add to your profile or enter for crew and vendor contacts.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Credentials</dt>
                <dd className="text-sm mt-0.5">
                  Password (stored as a bcrypt hash — we never see the plaintext). OAuth tokens for
                  connected integrations (OwnerRez, Uplisting) stored encrypted in Supabase Vault.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Business and Operational Data</dt>
                <dd className="text-sm mt-0.5">
                  Property details, booking records, crew schedules, vendor contacts, work orders,
                  inventory data, and financial transactions you enter into the Service. This data
                  is attributable to your organization and may include personal data about third parties
                  (crew members, vendors, property owners) that you provide to us.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Financial Data</dt>
                <dd className="text-sm mt-0.5">
                  Billing information is collected and processed directly by Stripe. We store only your
                  Stripe customer ID and subscription status — we never see or store full card numbers.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Usage and Technical Data</dt>
                <dd className="text-sm mt-0.5">
                  Pages visited, features used, error logs, browser type, IP address, and device
                  identifiers collected via server logs and our hosting infrastructure (Vercel).
                  This data is used to operate, debug, and improve the Service.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Communication Data</dt>
                <dd className="text-sm mt-0.5">
                  Records of messages sent via the in-app messaging system between property managers,
                  crew members, and vendors. Push notification tokens if you enable browser notifications.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Audit and Security Logs</dt>
                <dd className="text-sm mt-0.5">
                  Records of security-relevant actions taken in the Service (logins, permission changes,
                  data exports, deletions) associated with your user account ID and timestamp.
                </dd>
              </div>
            </dl>

            <p className="mt-4 font-medium text-gray-800">Sources</p>
            <ul className="list-disc pl-6 space-y-1 mt-2 text-sm">
              <li>Directly from you when you create an account, configure your organization, or use the Service.</li>
              <li>From connected third-party platforms (OwnerRez, Uplisting) when you authorize an integration.</li>
              <li>Automatically from your device and browser as you interact with the Service.</li>
              <li>From Stripe, for subscription and billing events.</li>
            </ul>

            <p className="mt-4 font-medium text-gray-800">Sensitive Personal Information</p>
            <p className="text-sm mt-1">
              We do not intentionally collect sensitive personal information as defined under CPRA
              (California Privacy Rights Act) — such as Social Security numbers, racial or ethnic
              origin, health data, or precise geolocation — as part of normal Service operation.
              Property addresses and zip codes are collected for operational purposes (geocoding for
              crew dispatch) and are not used for consumer profiling.
            </p>
          </section>

          {/* ── 3. Legal Basis for Processing (GDPR) ─────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. Legal Basis for Processing (GDPR)</h2>
            <p className="mb-3">
              If you are located in the European Economic Area (EEA) or United Kingdom, we process your
              personal data under the following legal bases:
            </p>
            <dl className="space-y-4">
              <div>
                <dt className="font-semibold text-gray-800">Contract Performance (Article 6(1)(b))</dt>
                <dd className="text-sm mt-0.5">
                  Processing necessary to provide the Service you have subscribed to — account creation,
                  property management operations, sending work order notifications to crew and vendors,
                  billing via Stripe, and delivering transactional emails.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Legitimate Interests (Article 6(1)(f))</dt>
                <dd className="text-sm mt-0.5">
                  Security and fraud prevention (maintaining audit logs, detecting unauthorized access);
                  service improvement (aggregated usage analytics, error monitoring); and product
                  communications (feature announcements to existing customers).
                  Our legitimate interests do not override your fundamental rights and freedoms —
                  we conducted a balancing test for each purpose and would share that assessment on request.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Legal Obligation (Article 6(1)(c))</dt>
                <dd className="text-sm mt-0.5">
                  Retention of financial transaction records for 7 years to comply with tax and accounting
                  regulations (U.S. IRS requirements; equivalent EU member state fiscal law).
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Consent (Article 6(1)(a))</dt>
                <dd className="text-sm mt-0.5">
                  Push notifications to your browser — only when you explicitly grant permission.
                  You may withdraw this consent at any time through your browser settings or in
                  Settings → Account.
                </dd>
              </div>
            </dl>
          </section>

          {/* ── 4. Purposes of Processing ─────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. Purposes of Processing</h2>
            <ul className="list-disc pl-6 space-y-2 text-sm">
              <li>To create and manage your account and organization.</li>
              <li>To operate the property management, crew scheduling, and work order workflows.</li>
              <li>To send transactional communications: invitation emails, work order assignments,
                billing receipts, and expiry alerts.</li>
              <li>To sync reservation data from connected third-party platforms when you authorize them.</li>
              <li>To process payments and manage your subscription through Stripe.</li>
              <li>To generate AI-assisted review responses (RepuGuard feature) using review text you submit.</li>
              <li>To maintain security logs and an audit trail for your organization.</li>
              <li>To detect, investigate, and prevent unauthorized access or abuse.</li>
              <li>To comply with applicable law and enforce our Terms of Service.</li>
              <li>To improve and develop the Service using aggregated, de-identified usage data.</li>
            </ul>
            <p className="mt-3 text-sm">
              We do not sell, rent, or share your personal data with third parties for their own
              marketing or advertising purposes. We do not use your data for cross-context behavioral
              advertising.
            </p>
          </section>

          {/* ── 5. Data Sharing and Sub-Processors ────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. Data Sharing and Sub-Processors</h2>
            <p className="mb-3">
              We share personal data only with the following categories of recipients, each acting as a
              data processor on our behalf under contractual data protection obligations:
            </p>
            <dl className="space-y-4">
              <div>
                <dt className="font-semibold text-gray-800">Supabase, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">
                  Database and authentication infrastructure. Your data is stored in the United States
                  (us-east-1 region). Supabase participates in the EU-US Data Privacy Framework.{' '}
                  <a href="https://supabase.com/privacy" className="underline" target="_blank" rel="noopener noreferrer">
                    Supabase Privacy Policy
                  </a>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Vercel, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">
                  Application hosting, edge network, and server-side rendering. Vercel processes
                  request logs including IP addresses.{' '}
                  <a href="https://vercel.com/legal/privacy-policy" className="underline" target="_blank" rel="noopener noreferrer">
                    Vercel Privacy Policy
                  </a>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Stripe, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">
                  Payment processing. Stripe is the data controller for payment card data. Stripe is
                  PCI DSS compliant and certified under the EU-US Data Privacy Framework.{' '}
                  <a href="https://stripe.com/privacy" className="underline" target="_blank" rel="noopener noreferrer">
                    Stripe Privacy Policy
                  </a>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Resend, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">
                  Transactional email delivery (work order notifications, invitations, billing receipts).
                  Email addresses and message content are transmitted for delivery purposes only.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Inngest, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">
                  Background job orchestration for asynchronous workflows. Receives event payloads
                  containing property and booking identifiers.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Anthropic, PBC (United States)</dt>
                <dd className="text-sm mt-0.5">
                  AI-powered review response generation (RepuGuard feature only). Guest review text is
                  transmitted to Anthropic&apos;s API to generate a draft response. Anthropic does not
                  retain this data beyond the API call per their enterprise data agreements.{' '}
                  <a href="https://www.anthropic.com/legal/privacy" className="underline" target="_blank" rel="noopener noreferrer">
                    Anthropic Privacy Policy
                  </a>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Mapbox, Inc. (United States)</dt>
                <dd className="text-sm mt-0.5">
                  Geocoding service. Property addresses and ZIP codes are transmitted to resolve
                  latitude/longitude coordinates for crew dispatch distance calculations.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Kroger Co. (United States)</dt>
                <dd className="text-sm mt-0.5">
                  Grocery and supply fulfillment (optional). If you connect your Kroger account via
                  OAuth, your Kroger access token is stored encrypted. Property addresses may be
                  transmitted to identify the nearest store.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Crisp, Inc. (France)</dt>
                <dd className="text-sm mt-0.5">
                  Live chat support. Session cookies used to maintain chat state.
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-sm">
              We may also disclose personal data: (a) to comply with a court order, subpoena, or
              applicable law; (b) to enforce our Terms of Service; (c) to protect the rights, property,
              or safety of FieldStay, our users, or the public; or (d) in connection with a merger,
              acquisition, or sale of all or substantially all of our assets, in which case the
              acquirer would be bound by this Privacy Policy.
            </p>
          </section>

          {/* ── 6. International Data Transfers ──────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">6. International Data Transfers</h2>
            <p>
              FieldStay is headquartered in the United States. If you access the Service from the
              European Economic Area (EEA), United Kingdom, or Switzerland, your personal data is
              transferred to and processed in the United States.
            </p>
            <p className="mt-3">
              We rely on the following transfer mechanisms to ensure an adequate level of protection:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-2 text-sm">
              <li>
                <strong>EU-US Data Privacy Framework (DPF):</strong> Our primary sub-processors
                (Supabase, Vercel, Stripe) are certified under the EU-US DPF, which was deemed adequate
                by the European Commission in Decision 2023/1795. Their DPF certifications are listed
                on the DPF website maintained by the U.S. Department of Commerce.
              </li>
              <li>
                <strong>Standard Contractual Clauses (SCCs):</strong> Where sub-processors are not
                DPF-certified, we rely on the European Commission&apos;s Standard Contractual Clauses
                (Commission Implementing Decision 2021/914) incorporated into our data processing
                agreements with those processors.
              </li>
            </ul>
            <p className="mt-3 text-sm">
              You may request a copy of the applicable transfer mechanisms by contacting us at{' '}
              <a href={`mailto:${PRIVACY_EMAIL}`} className="underline">{PRIVACY_EMAIL}</a>.
            </p>
          </section>

          {/* ── 7. Cookies and Local Storage ─────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">7. Cookies and Local Storage</h2>
            <p>
              We use only strictly necessary cookies for session management (keeping you logged in)
              and a <code className="bg-gray-100 px-1 rounded text-sm">localStorage</code> entry to
              remember your theme preference. No advertising, tracking, or analytics cookies are set.
            </p>
            <p className="mt-3">
              We also use Crisp (crisp.chat) to provide live chat support. Crisp may
              set cookies to maintain chat session state.{' '}
              <a href="https://crisp.chat/en/privacy/" className="underline"
                 target="_blank" rel="noopener noreferrer">
                See Crisp&apos;s privacy policy
              </a>
              .
            </p>
            <p className="mt-3 text-sm">
              Because we use only technically necessary cookies, consent is not required under the
              GDPR ePrivacy Directive or CPRA for these cookies. You may delete all cookies via your
              browser settings, which will log you out of the Service.
            </p>
          </section>

          {/* ── 8. Data Retention ────────────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">8. Data Retention</h2>
            <p className="mb-3">
              We retain personal data only for as long as necessary for the purposes set out in this
              policy, or as required by law. The specific retention periods are:
            </p>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-semibold text-gray-800">Account and Profile Data</dt>
                <dd>Retained for the life of your account. Deleted within 30 days of account deletion.</dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Business Operational Data</dt>
                <dd>
                  (Properties, bookings, work orders, crew records.) Retained for the life of your
                  account. Deleted within 30 days of account deletion, subject to legal holds.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Financial Transaction Records</dt>
                <dd>
                  Billing receipts and owner transaction audit entries are retained for <strong>7 years</strong>{' '}
                  from the date of the transaction to comply with IRS record-keeping requirements
                  (Rev. Proc. 98-25) and GAAP. These records may be retained even after account deletion.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Security and Access Logs (Audit Events)</dt>
                <dd>
                  Operational audit events (logins, permission changes, data exports) are retained for{' '}
                  <strong>3 years</strong> from the date of the event, consistent with SOC 2 Type II
                  audit requirements and GDPR&apos;s reasonable retention standard for security logs.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Communication Logs</dt>
                <dd>
                  In-app messages are retained per the retention period configured by your organization
                  (default: 365 days), after which they are soft-deleted and permanently purged 30 days
                  later.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Push Notification Tokens</dt>
                <dd>Deleted immediately when you revoke notification permissions or delete your account.</dd>
              </div>
            </dl>
          </section>

          {/* ── 9. Your Rights (GDPR — EEA/UK/Switzerland) ──────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">9. Your Rights Under GDPR</h2>
            <p className="mb-3">
              If you are located in the EEA, United Kingdom, or Switzerland, you have the following
              rights under the General Data Protection Regulation (GDPR) and equivalent national law:
            </p>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-semibold text-gray-800">Right of Access (Article 15)</dt>
                <dd>
                  You may request confirmation of whether we process your personal data, and a copy
                  of that data together with information about how it is processed. Use the
                  &ldquo;Export My Data&rdquo; function in Settings → Audit Log, or email us.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Rectification (Article 16)</dt>
                <dd>
                  You may correct inaccurate personal data by editing your profile in Settings → Account.
                  For data you cannot self-edit, contact us.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Erasure (Article 17)</dt>
                <dd>
                  You may request deletion of your personal data where: (a) the data is no longer
                  necessary for the purpose it was collected; (b) you withdraw consent and no other
                  legal basis applies; (c) you object and we have no overriding legitimate interests;
                  or (d) we have processed your data unlawfully. Note: legal retention obligations
                  (e.g., 7-year financial records) may prevent immediate full deletion.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Restriction (Article 18)</dt>
                <dd>
                  You may request that we restrict processing of your personal data in limited
                  circumstances (e.g., while we verify a rectification request or pending resolution
                  of an objection).
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Data Portability (Article 20)</dt>
                <dd>
                  For data you provided to us based on contract or consent, you may receive a structured,
                  machine-readable copy of your personal data. Use the &ldquo;Export My Data&rdquo;
                  function (JSON format) in Settings → Audit Log.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Object (Article 21)</dt>
                <dd>
                  You may object to processing based on our legitimate interests. We will stop processing
                  unless we can demonstrate compelling legitimate grounds that override your interests,
                  or the processing is necessary for legal claims.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Withdraw Consent (Article 7(3))</dt>
                <dd>
                  Where processing is based on consent (e.g., push notifications), you may withdraw
                  consent at any time without affecting the lawfulness of prior processing. Withdraw via
                  Settings → Account or your browser&apos;s notification permissions.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">
                  Rights Related to Automated Decision-Making (Article 22)
                </dt>
                <dd>
                  FieldStay uses automated crew assignment suggestions based on location, availability,
                  and historical performance scores. This automation produces <em>recommendations</em>{' '}
                  that a human property manager reviews and approves or overrides — it does not produce
                  decisions with legal or similarly significant effects on individuals. Crew members
                  are not excluded from consideration based solely on algorithmic output.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">
                  Right to Lodge a Complaint (Article 77)
                </dt>
                <dd>
                  You have the right to lodge a complaint with your local supervisory authority. In the
                  EU, find your authority at{' '}
                  <a
                    href="https://edpb.europa.eu/about-edpb/about-edpb/members_en"
                    className="underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    edpb.europa.eu
                  </a>
                  . In the UK, contact the ICO at{' '}
                  <a href="https://ico.org.uk" className="underline" target="_blank" rel="noopener noreferrer">
                    ico.org.uk
                  </a>
                  . We encourage you to contact us first — most concerns can be resolved directly.
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-sm">
              <strong>Response timeframe:</strong> We will respond to your request within 30 days.
              If the request is complex or numerous, we may extend by up to 2 additional months with
              prior notice. Requests are free of charge unless manifestly unfounded or excessive.
              Submit requests to{' '}
              <a href={`mailto:${PRIVACY_EMAIL}`} className="underline">{PRIVACY_EMAIL}</a>.
            </p>
            <p className="mt-3 text-sm">
              <strong>Provision requirement:</strong> Providing your name and email address is
              contractually required to create an account and use the Service. Without this data
              we cannot provide the Service. All other data fields are voluntary.
            </p>
          </section>

          {/* ── 10. California Privacy Rights (CCPA / CPRA) ─────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">
              10. California Privacy Rights (CCPA / CPRA)
            </h2>
            <p className="mb-3">
              If you are a California resident, the California Consumer Privacy Act (CCPA) and the
              California Privacy Rights Act (CPRA) grant you the following rights:
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Categories of Personal Information Collected</h3>
            <ul className="list-disc pl-6 space-y-1 text-sm">
              <li>Identifiers (name, email address, IP address, user ID)</li>
              <li>Commercial information (subscription plan, billing history via Stripe)</li>
              <li>Internet or other electronic network activity (usage logs, feature interaction data)</li>
              <li>Professional or employment-related information (crew role, reliability scores)</li>
              <li>Inferences drawn from the above (crew assignment recommendations)</li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">We Do Not Sell or Share Your Personal Information</h3>
            <p className="text-sm">
              FieldStay does not sell your personal information within the meaning of CCPA § 1798.100
              or share it for cross-context behavioral advertising within the meaning of CPRA
              § 1798.140(ah). No opt-out is required because we do not engage in these activities.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Your CCPA / CPRA Rights</h3>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-semibold text-gray-800">Right to Know (§ 1798.100)</dt>
                <dd>
                  You may request disclosure of the categories and specific pieces of personal information
                  we have collected about you, the categories of sources, the business purposes for
                  collection, and the categories of third parties with whom it is shared.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Delete (§ 1798.105)</dt>
                <dd>
                  You may request deletion of your personal information, subject to exceptions (e.g.,
                  completing transactions, legal obligations, security purposes).
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Correct (§ 1798.106 — CPRA)</dt>
                <dd>
                  You may request correction of inaccurate personal information we maintain about you.
                  Edit your profile in Settings → Account or submit a correction request.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Opt-Out of Sale/Sharing (§ 1798.120)</dt>
                <dd>
                  As noted above, we do not sell or share personal information. No opt-out mechanism
                  is required, but you may contact us to confirm.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Limit Use of Sensitive Personal Information (§ 1798.121 — CPRA)</dt>
                <dd>
                  We do not use sensitive personal information for purposes beyond those necessary to
                  perform the Service. No limitation request is needed.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Right to Non-Discrimination (§ 1798.125)</dt>
                <dd>
                  We will not discriminate against you for exercising any of your CCPA/CPRA rights.
                  We will not deny you the Service, charge different prices, or provide a different
                  level of service based on your exercise of these rights.
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-sm">
              <strong>Response timeframe:</strong> We will respond to verifiable California consumer
              requests within 45 days. We may extend by an additional 45 days where reasonably
              necessary with prior notice. Submit requests to{' '}
              <a href={`mailto:${PRIVACY_EMAIL}`} className="underline">{PRIVACY_EMAIL}</a> or use the
              account deletion feature in Settings → Account. We will verify your identity before
              fulfilling deletion or access requests.
            </p>
            <p className="mt-3 text-sm">
              <strong>Authorized agents:</strong> California residents may designate an authorized
              agent to submit requests on their behalf. We may require written authorization and
              identity verification.
            </p>
          </section>

          {/* ── 11. Do Not Track (CalOPPA) ───────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">11. Do Not Track</h2>
            <p className="text-sm">
              California&apos;s Online Privacy Protection Act (CalOPPA) requires disclosure of how we
              respond to Do Not Track (DNT) signals. FieldStay does not respond to DNT signals because
              we do not engage in cross-site tracking of any kind. We do not track your activities
              across third-party websites or services.
            </p>
          </section>

          {/* ── 12. Security ─────────────────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">12. Security</h2>
            <p>
              We implement technical and organizational measures appropriate to the risk, including:
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2 text-sm">
              <li>TLS 1.2+ encryption for all data in transit.</li>
              <li>AES-256 encryption at rest for sensitive credentials and tokens in Supabase Vault.</li>
              <li>Row-Level Security (RLS) policies on every database table enforcing tenant isolation.</li>
              <li>Role-based access controls (admin, manager, crew, viewer, owner).</li>
              <li>Append-only audit log for all security-relevant actions.</li>
              <li>Stripe-side storage of payment card data (we never receive or store card numbers).</li>
            </ul>
            <p className="mt-3 text-sm">
              No method of transmission over the Internet or electronic storage is 100% secure.
              If you discover a security vulnerability, please report it to{' '}
              <a href={`mailto:${PRIVACY_EMAIL}`} className="underline">{PRIVACY_EMAIL}</a>.
            </p>
          </section>

          {/* ── 13. Children ─────────────────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">13. Children</h2>
            <p className="text-sm">
              The Service is directed to and intended for use only by individuals who are 18 years of
              age or older. We do not knowingly collect personal information from children under 13
              (or under 16 in the EEA). If you believe we have inadvertently collected personal
              information from a minor, contact us immediately at{' '}
              <a href={`mailto:${PRIVACY_EMAIL}`} className="underline">{PRIVACY_EMAIL}</a> and we will
              delete it promptly.
            </p>
          </section>

          {/* ── 14. Changes to This Policy ───────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">14. Changes to This Policy</h2>
            <p className="text-sm">
              We may update this policy to reflect changes in our practices, technology, or applicable
              law. Material changes will be communicated by email to registered account holders at
              least 30 days before taking effect. The revised effective date will be updated at the
              top of this page. Continued use of the Service after the effective date constitutes
              acceptance of the revised policy.
            </p>
          </section>

          {/* ── 15. Contact ──────────────────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">15. Contact Us</h2>
            <p>
              For any privacy questions, requests, or concerns, contact our privacy team at:
            </p>
            <address className="not-italic mt-3 text-sm space-y-1">
              <p><strong>{CONTROLLER_NAME}</strong></p>
              <p>
                Email:{' '}
                <a href={`mailto:${PRIVACY_EMAIL}`} className="underline">{PRIVACY_EMAIL}</a>
              </p>
            </address>
            <p className="mt-4 text-sm">
              EEA/UK residents with unresolved complaints may also contact your local data protection
              supervisory authority. EU authority directory:{' '}
              <a
                href="https://edpb.europa.eu/about-edpb/about-edpb/members_en"
                className="underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                edpb.europa.eu
              </a>
              . UK: ICO at{' '}
              <a href="https://ico.org.uk/make-a-complaint" className="underline" target="_blank" rel="noopener noreferrer">
                ico.org.uk
              </a>
              .
            </p>
          </section>

        </div>
      </div>
    </div>
  )
}
