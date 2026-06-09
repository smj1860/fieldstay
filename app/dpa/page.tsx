import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Data Processing Agreement — FieldStay' }

const EFFECTIVE_DATE  = 'June 9, 2026'
const CONTROLLER_NAME = 'FieldStay, Inc.'
const PRIVACY_EMAIL   = 'privacy@fieldstay.app'

export default function DpaPage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <Link href="/privacy" className="text-sm text-gray-500 hover:text-gray-700 mb-8 inline-block">
          ← Back to Privacy Policy
        </Link>

        <h1 className="text-3xl font-bold text-gray-900 mb-2">Data Processing Agreement</h1>
        <p className="text-sm text-gray-500 mb-2">Effective: {EFFECTIVE_DATE}</p>
        <p className="text-sm text-gray-500 mb-10">
          This Data Processing Agreement (&ldquo;DPA&rdquo;) forms part of the FieldStay Terms of
          Service between {CONTROLLER_NAME} (&ldquo;Processor&rdquo; or &ldquo;FieldStay&rdquo;) and
          the organization using the FieldStay platform (&ldquo;Controller&rdquo;). It governs the
          processing of personal data by FieldStay on behalf of the Controller in connection with the
          FieldStay service.
        </p>

        <div className="prose prose-gray max-w-none space-y-10 text-gray-700">

          {/* ── 1. Definitions ──────────────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. Definitions</h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-semibold text-gray-800">&ldquo;GDPR&rdquo;</dt>
                <dd>
                  Regulation (EU) 2016/679 of the European Parliament and of the Council of 27 April
                  2016 on the protection of natural persons with regard to the processing of personal data
                  (&ldquo;General Data Protection Regulation&rdquo;) and, where applicable, the UK GDPR
                  as retained in UK law under the European Union (Withdrawal) Act 2018.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">&ldquo;Personal Data,&rdquo; &ldquo;Processing,&rdquo; &ldquo;Controller,&rdquo; &ldquo;Processor,&rdquo; &ldquo;Data Subject,&rdquo; &ldquo;Supervisory Authority&rdquo;</dt>
                <dd>
                  Have the meanings given in Article 4 of the GDPR.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">&ldquo;Sub-Processor&rdquo;</dt>
                <dd>
                  Any third party engaged by FieldStay to process Personal Data on behalf of the
                  Controller in connection with the Service.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">&ldquo;Service&rdquo;</dt>
                <dd>
                  The FieldStay property operations platform and all associated features made available
                  to the Controller under the Terms of Service.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">&ldquo;Security Incident&rdquo;</dt>
                <dd>
                  Any accidental or unlawful destruction, loss, alteration, unauthorized disclosure of,
                  or access to, Personal Data transmitted, stored, or otherwise processed by FieldStay.
                </dd>
              </div>
            </dl>
          </section>

          {/* ── 2. Scope and Role of the Parties ───────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. Scope and Role of the Parties</h2>
            <p className="text-sm">
              The Controller is the FieldStay customer (the property management organization) that
              determines the purposes and means of Processing Personal Data entered into and managed
              through the Service — including data about crew members, vendors, property owners, guests,
              and bookings (&ldquo;Controller Personal Data&rdquo;).
            </p>
            <p className="mt-3 text-sm">
              FieldStay acts as a Processor of Controller Personal Data and processes that data only on
              behalf of and at the direction of the Controller, in accordance with this DPA and the
              Terms of Service.
            </p>
            <p className="mt-3 text-sm">
              FieldStay is an independent Controller of data about its own users (account holders,
              platform administrators) for the purposes of managing accounts and subscriptions. That
              processing is governed by the{' '}
              <Link href="/privacy" className="underline hover:text-gray-700">FieldStay Privacy Policy</Link>
              , not this DPA.
            </p>
          </section>

          {/* ── 3. Details of Processing ────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. Details of Processing</h2>
            <p className="text-sm mb-3">As required by GDPR Article 28(3), the subject matter and details of the Processing are:</p>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-semibold text-gray-800">Subject Matter</dt>
                <dd>
                  The provision of the FieldStay property operations platform to the Controller.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Duration</dt>
                <dd>
                  For the term of the Controller&apos;s subscription to the Service, plus any retention
                  periods required by applicable law following termination.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Nature and Purpose of Processing</dt>
                <dd>
                  Storage, retrieval, transmission, and display of Controller Personal Data to operate
                  features including: crew scheduling and dispatch, vendor work order management,
                  inventory tracking, booking management, owner reporting, and communications.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Type of Personal Data</dt>
                <dd>
                  Names, email addresses, phone numbers, and role information of crew members, vendors,
                  and property owners entered by the Controller. Guest names, email addresses, and
                  arrival/departure dates from connected booking platforms. Property addresses and
                  operational notes.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-gray-800">Categories of Data Subjects</dt>
                <dd>
                  Crew members, vendors, property owners, and guests whose data the Controller enters
                  or imports into the Service.
                </dd>
              </div>
            </dl>
          </section>

          {/* ── 4. Processor Obligations (GDPR Article 28(3)) ───────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">
              4. Processor Obligations (GDPR Article 28(3))
            </h2>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">4.1 Processing on Instructions Only</h3>
            <p className="text-sm">
              FieldStay will process Controller Personal Data only on documented instructions from the
              Controller. The Controller&apos;s use of the Service (including configuration, integrations,
              and API calls) constitutes documented instructions. If FieldStay is required by applicable
              law to process Controller Personal Data in a manner not covered by those instructions, it
              will notify the Controller before processing (unless prohibited by law on grounds of public
              interest). If FieldStay reasonably believes an instruction infringes applicable data
              protection law, it will promptly notify the Controller.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">4.2 Confidentiality</h3>
            <p className="text-sm">
              FieldStay will ensure that personnel authorized to process Controller Personal Data are
              subject to appropriate confidentiality obligations — whether by employment contract,
              statutory duty, or equivalent binding obligation — and are informed of the confidential
              nature of the data.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">4.3 Security Measures (GDPR Article 32)</h3>
            <p className="text-sm mb-2">
              FieldStay will implement and maintain appropriate technical and organizational security
              measures to protect Controller Personal Data against accidental or unlawful destruction,
              loss, alteration, unauthorized disclosure, or access. These measures currently include:
            </p>
            <ul className="list-disc pl-6 space-y-1 text-sm">
              <li>Encryption of data in transit using TLS 1.2 or higher.</li>
              <li>Encryption of sensitive credentials and OAuth tokens at rest (AES-256 via Supabase Vault).</li>
              <li>Row-Level Security enforced at the database layer to prevent cross-tenant data access.</li>
              <li>Role-based access controls limiting personnel access to data needed to perform their role.</li>
              <li>Append-only audit logs for all security-relevant operations.</li>
              <li>Regular review of access permissions and security configurations.</li>
            </ul>
            <p className="mt-2 text-sm">
              FieldStay will take steps to ensure that any natural person acting under its authority who
              has access to Controller Personal Data processes it only in accordance with this DPA, unless
              required to do so by applicable law.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">4.4 Sub-Processors</h3>
            <p className="text-sm">
              The Controller provides general authorization for FieldStay to engage Sub-Processors.
              The current list of Sub-Processors is published in the{' '}
              <Link href="/privacy#sub-processors" className="underline hover:text-gray-700">
                Privacy Policy (Section 5)
              </Link>
              .
            </p>
            <p className="mt-2 text-sm">
              Before engaging a new Sub-Processor or replacing an existing one, FieldStay will notify
              the Controller (by updating the Privacy Policy and, for material changes, by email to the
              Controller&apos;s account holder) at least 30 days in advance. The Controller may object in
              writing within that 30-day period on data protection grounds; if FieldStay cannot
              accommodate the objection, the Controller may terminate the affected portion of the Service.
            </p>
            <p className="mt-2 text-sm">
              FieldStay will impose data protection obligations on all Sub-Processors equivalent to those
              in this DPA, as required by GDPR Article 28(4). FieldStay remains liable to the Controller
              for the performance of Sub-Processors&apos; obligations.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">4.5 Assistance with Data Subject Rights</h3>
            <p className="text-sm">
              FieldStay will, to the extent technically possible and taking into account the nature of
              the Processing, assist the Controller in fulfilling its obligations to respond to Data
              Subject rights requests (access, rectification, erasure, restriction, portability,
              objection) under GDPR Chapter III. Given the nature of the Service, the Controller can
              directly fulfill most Data Subject rights requests using the Service&apos;s built-in
              tools (data export, account deletion). Where built-in tools are insufficient, FieldStay
              will provide reasonable assistance upon written request.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">4.6 Assistance with Compliance Obligations</h3>
            <p className="text-sm mb-2">
              FieldStay will assist the Controller in ensuring compliance with the obligations under
              GDPR Articles 32–36, taking into account the nature of the Processing and the information
              available to FieldStay, including with respect to:
            </p>
            <ul className="list-disc pl-6 space-y-1 text-sm">
              <li>
                <strong>Security (Article 32):</strong> Providing information about FieldStay&apos;s
                technical and organizational security measures on request.
              </li>
              <li>
                <strong>Breach Notification (Articles 33–34):</strong> Notifying the Controller of any
                Security Incident without undue delay and, where feasible, within 72 hours of FieldStay
                becoming aware of it, to enable the Controller to meet its own notification obligations
                to the Supervisory Authority and affected Data Subjects.
              </li>
              <li>
                <strong>Data Protection Impact Assessment (Article 35):</strong> Providing reasonable
                information and cooperation to assist the Controller in conducting any required DPIA
                relating to Processing performed by FieldStay.
              </li>
              <li>
                <strong>Prior Consultation (Article 36):</strong> Providing reasonable assistance where
                a DPIA indicates a high risk requiring consultation with a Supervisory Authority.
              </li>
            </ul>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">4.7 Return or Deletion of Data</h3>
            <p className="text-sm">
              Upon termination or expiry of the Service subscription, FieldStay will, at the
              Controller&apos;s election (communicated by email within 30 days of termination):
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2 text-sm">
              <li>
                <strong>Return:</strong> Provide the Controller with an export of Controller Personal
                Data in a structured, machine-readable format (JSON).
              </li>
              <li>
                <strong>Delete:</strong> Securely delete Controller Personal Data from FieldStay&apos;s
                production systems within 30 days of the termination date, except where retention is
                required by applicable law (e.g., financial records subject to a 7-year statutory
                retention period).
              </li>
            </ul>
            <p className="mt-2 text-sm">
              If the Controller does not elect within 30 days of termination, FieldStay will delete
              Controller Personal Data per its standard retention schedule. FieldStay will certify
              deletion in writing upon request.
            </p>

            <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">4.8 Audit and Compliance Demonstration</h3>
            <p className="text-sm">
              FieldStay will make available to the Controller all information necessary to demonstrate
              compliance with GDPR Article 28, and will allow for and contribute to audits and
              inspections conducted by the Controller or an auditor mandated by the Controller. FieldStay
              may satisfy this obligation by providing:
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2 text-sm">
              <li>Relevant certifications, security attestations (e.g., SOC 2 Type II reports), or
                penetration test summaries, subject to confidentiality obligations.</li>
              <li>Written responses to Controller security questionnaires.</li>
              <li>Where required, participation in on-site or remote audits on reasonable notice (at
                least 30 days), during normal business hours, and subject to a confidentiality agreement.</li>
            </ul>
          </section>

          {/* ── 5. Controller Obligations ───────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. Controller Obligations</h2>
            <p className="text-sm">The Controller represents and warrants that:</p>
            <ul className="list-disc pl-6 space-y-2 mt-2 text-sm">
              <li>
                It has a lawful basis to collect and transfer Controller Personal Data to FieldStay for
                processing under this DPA (e.g., it has obtained appropriate consent from crew members
                for operational processing, or relies on legitimate interest or employment contract).
              </li>
              <li>
                It has provided all required privacy notices to Data Subjects whose data is entered into
                the Service, informing them that their data may be processed by FieldStay as a Processor.
              </li>
              <li>
                It will comply with applicable data protection law in its own use of the Service,
                including the accuracy of the data it enters and the lawfulness of any instructions
                given to FieldStay.
              </li>
              <li>
                It will not instruct FieldStay to process Personal Data in a way that would infringe
                applicable data protection law.
              </li>
            </ul>
          </section>

          {/* ── 6. International Data Transfers ─────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">6. International Data Transfers</h2>
            <p className="text-sm">
              FieldStay processes Controller Personal Data in the United States. To the extent that
              Controller Personal Data originates from the EEA, UK, or Switzerland, the transfer is
              governed by the applicable transfer mechanism described in the{' '}
              <Link href="/privacy" className="underline hover:text-gray-700">Privacy Policy (Section 6)</Link>
              , which is incorporated by reference into this DPA.
            </p>
            <p className="mt-3 text-sm">
              If Standard Contractual Clauses (SCCs) are required to legitimize a transfer, the
              Controller and FieldStay agree that the EU Commission&apos;s 2021 SCCs (Module 2:
              Controller-to-Processor) are incorporated into this DPA by reference and apply to such
              transfers. The SCCs are available at{' '}
              <a
                href="https://ec.europa.eu/info/law/law-topic/data-protection/international-dimension-data-protection/standard-contractual-clauses-scc_en"
                className="underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                ec.europa.eu
              </a>
              . The Parties agree that Annex I (description of transfers) is fulfilled by Section 3
              (Details of Processing) of this DPA, and Annex II (technical/organizational measures) is
              fulfilled by Section 4.3 above.
            </p>
          </section>

          {/* ── 7. Liability ─────────────────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">7. Liability</h2>
            <p className="text-sm">
              Each Party&apos;s liability under this DPA is subject to the limitations and exclusions set
              out in the FieldStay Terms of Service. To the extent permitted by applicable law, FieldStay&apos;s
              liability for breaches of this DPA is limited to direct damages and does not include
              indirect, consequential, or punitive damages. Nothing in this DPA limits liability that
              cannot be excluded or limited under applicable law (including GDPR Article 82).
            </p>
          </section>

          {/* ── 8. Term and Termination ──────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">8. Term and Termination</h2>
            <p className="text-sm">
              This DPA is effective from the date the Controller accepts the Terms of Service (or the
              effective date above, whichever is later) and continues for as long as FieldStay processes
              Controller Personal Data under the Terms of Service. Termination of the Terms of Service
              automatically terminates this DPA, subject to Section 4.7 (data return/deletion).
            </p>
          </section>

          {/* ── 9. Order of Precedence ───────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">9. Order of Precedence</h2>
            <p className="text-sm">
              In the event of a conflict between this DPA and the Terms of Service with respect to
              the processing of Controller Personal Data, the terms of this DPA prevail. In the event
              of a conflict between this DPA and the SCCs, the SCCs prevail.
            </p>
          </section>

          {/* ── 10. Contact ──────────────────────────────────────────────────────────── */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">10. Contact</h2>
            <p className="text-sm">
              To exercise rights under this DPA, request a signed copy, or raise a data protection
              concern, contact:
            </p>
            <address className="not-italic mt-3 text-sm space-y-1">
              <p><strong>{CONTROLLER_NAME}</strong> — Data Privacy</p>
              <p>
                Email:{' '}
                <a href={`mailto:${PRIVACY_EMAIL}`} className="underline">{PRIVACY_EMAIL}</a>
              </p>
            </address>
          </section>

        </div>
      </div>
    </div>
  )
}
