import { Resend } from 'resend'
import { RESEND_TIMEOUT_MS } from '@/lib/http/timeout'
import { renderTeamInviteEmail }   from '@/emails/team-invite'
import { renderOwnerPortalEmail } from '@/emails/owner-portal'
import { renderGuestPreArrivalEmail } from '@/emails/guest-pre-arrival'
import { renderGuidebookGracePeriodEmail } from '@/emails/guidebook-grace-period'
import { renderHospitablePriceLockEmail } from '@/emails/hospitable-price-lock'

/**
 * Resend client — single instance for all transactional email.
 * Only used server-side (Inngest functions, API routes).
 *
 * Constructed lazily via Proxy, not at module load — Resend's constructor
 * throws ("Missing API key") on an empty string, and this file is imported
 * widely enough that Next.js's build-time page-data-collection pass would
 * crash outright in any environment without RESEND_API_KEY set. The Proxy
 * keeps every existing `resend.emails.send(...)` call site unchanged.
 */
let realClient: Resend | null = null

function getClient(): Resend {
  if (!realClient) {
    realClient = new Resend(process.env.RESEND_API_KEY ?? '')
  }
  return realClient
}

export const resend = new Proxy({} as Resend, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver)
  },
})

export const FROM = `${process.env.RESEND_FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`

/** Raised when a send exceeds RESEND_TIMEOUT_MS — distinct from a Resend API error. */
export class ResendTimeoutError extends Error {
  constructor() {
    super(`Resend send exceeded ${RESEND_TIMEOUT_MS}ms`)
    this.name = 'ResendTimeoutError'
  }
}

/**
 * Time-box a Resend send.
 *
 * Every other outbound integration is timeout-enforced, and
 * `unit/guardrails/external-fetch-timeout.test.ts` keeps them that way — but it
 * matches raw `fetch()` calls, and Resend goes through its SDK, so this one
 * surface was invisible to the guardrail and had no budget at all. A slow
 * Resend held the enclosing Inngest step open until the PLATFORM timeout killed
 * the whole function, which is both the slowest possible failure and the one
 * that takes unrelated work down with it.
 *
 * ── Why a race and not an AbortSignal ───────────────────────────────────────
 *
 * There is no signal to pass. Resend's `PostOptions` is `{ query?: … }` and the
 * string "signal" does not appear in the published SDK, so the request cannot
 * be cancelled — only stopped being waited on. The socket runs to completion in
 * the background and the send may well succeed after we have given up.
 *
 * ── Why abandoning an unknown outcome is safe ───────────────────────────────
 *
 * Because the retry is deduplicated at Resend, not here. Resend's
 * `IdempotentRequest` sends an `Idempotency-Key` header, and this codebase
 * already passes one on the sends that matter. A timed-out send that actually
 * landed, retried by Inngest with the same key, is rejected as a duplicate
 * rather than delivered twice — which is exactly the 409 the daily wrap-up
 * produces today.
 *
 * So: pass an idempotencyKey on anything a duplicate would be visible for. The
 * timeout narrows the window; the key is what closes it.
 */
export async function sendWithTimeout<T>(send: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      send(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ResendTimeoutError()), RESEND_TIMEOUT_MS)
      }),
    ])
  } finally {
    // Always cleared, including on the happy path — an uncleared timer keeps
    // the Node process alive for the full budget after the send resolved.
    if (timer) clearTimeout(timer)
  }
}

export async function sendTeamInviteEmail({
  toEmail,
  inviterEmail,
  orgName,
  inviteToken,
}: {
  toEmail:      string
  inviterEmail: string
  orgName:      string
  inviteToken:  string
}) {
  const acceptUrl = `${process.env.NEXT_PUBLIC_APP_URL}/accept-invite/${inviteToken}`
  const html      = await renderTeamInviteEmail({ inviterEmail, orgName, acceptUrl })

  return sendWithTimeout(() => resend.emails.send({
    from:     FROM,
    to:       toEmail,
    replyTo:  'stephen@fieldstay.app',
    subject:  `You've been invited to join ${orgName} on FieldStay`,
    html,
  }))
}

export async function sendOwnerPortalEmail({
  toEmail,
  ownerName,
  orgName,
  propertyName,
  portalUrl,
}: {
  toEmail:      string
  ownerName:    string
  orgName:      string
  propertyName: string
  portalUrl:    string
}) {
  const html = await renderOwnerPortalEmail({ ownerName, orgName, propertyName, portalUrl })
  return sendWithTimeout(() => resend.emails.send({
    from:    FROM,
    to:      toEmail,
    replyTo: 'help@fieldstay.app',
    subject: `Your owner portal for ${propertyName} is ready — FieldStay`,
    html,
  }))
}

/**
 * Guest-facing pre-arrival email. `orgId` opts the send into demo-org
 * suppression — the roadshow seed data uses @example.com addresses, and a
 * live send to those would bounce and cost real domain reputation. Same
 * chokepoint reasoning as sendSMS's orgId option in lib/sms/telnyx.ts.
 *
 * This is deliberately applied ONLY to guest-facing mail. Internal PM mail
 * (team invites, digests, owner-portal links to the demo operator) stays real
 * even for the demo org — those are useful to actually receive.
 */
export async function sendGuestPreArrivalEmail({
  toEmail,
  guestName,
  propertyName,
  optInUrl,
  guidebookUrl,
  orgId,
}: {
  toEmail:      string
  guestName:    string
  propertyName: string
  optInUrl:     string
  guidebookUrl: string
  orgId?:       string
}) {
  const html = await renderGuestPreArrivalEmail({ guestName, propertyName, optInUrl, guidebookUrl })

  const dispatch = () => sendWithTimeout(() => resend.emails.send({
    from:    FROM,
    to:      toEmail,
    replyTo: 'help@fieldstay.app',
    subject: `Get your door code by text — ${propertyName}`,
    html,
  }))

  if (!orgId) return dispatch()

  // Lazy import for the same reason as lib/sms/telnyx.ts's: this module is
  // widely imported and should not drag the Supabase service client into
  // every graph that sends any email.
  const [{ isDemoOrg }, { simulateOrSend, redactEmail }] = await Promise.all([
    import('@/lib/demo/org'),
    import('@/lib/demo/simulate'),
  ])

  if (!(await isDemoOrg(orgId))) return dispatch()

  return simulateOrSend(
    true,
    {
      orgId,
      kind:    'email',
      payload: { to: redactEmail(toEmail), template: 'guest_pre_arrival', propertyName },
    },
    dispatch,
    // Shaped like a Resend success so the caller's `error`/`data` branching
    // takes the same path it would in production.
    { data: { id: `demo_email_${crypto.randomUUID()}` }, error: null } as Awaited<ReturnType<typeof dispatch>>,
  )
}

export async function sendGuidebookGracePeriodEmail({
  toEmail,
  orgName,
  activeSponsors,
  gracePeriodEndsAt,
  guidebookUrl,
}: {
  toEmail:           string
  orgName:           string
  activeSponsors:    number
  gracePeriodEndsAt: string
  guidebookUrl:      string
}) {
  const html = await renderGuidebookGracePeriodEmail({ orgName, activeSponsors, gracePeriodEndsAt, guidebookUrl })
  return sendWithTimeout(() => resend.emails.send({
    from:    FROM,
    to:      toEmail,
    replyTo: 'help@fieldstay.app',
    subject: `Action needed: your guidebook needs sponsors — FieldStay`,
    html,
  }))
}

export async function sendHospitablePriceLockEmail({
  toEmail,
  organizationName,
  sequenceNumber,
  lockYears,
  lockedTierName,
  lockedPriceCents,
}: {
  toEmail:          string
  organizationName: string
  sequenceNumber:    number | null // null for the tier-2 (1-year) lock
  lockYears:         1 | 2
  lockedTierName:    string
  lockedPriceCents:  number
}) {
  const lockedPriceDisplay = `$${(lockedPriceCents / 100).toFixed(0)}/mo`
  const html = await renderHospitablePriceLockEmail({
    organizationName,
    sequenceNumber,
    lockYears,
    lockedTierName,
    lockedPriceDisplay,
  })

  const subject = sequenceNumber !== null
    ? `You're locked in, ${organizationName} — FieldStay + Hospitable launch`
    : `Your plan's price-locked, ${organizationName} — thanks for connecting via Hospitable`

  return sendWithTimeout(() => resend.emails.send({
    from:    FROM,
    to:      toEmail,
    replyTo: 'stephen@fieldstay.app',
    subject,
    html,
  }))
}
