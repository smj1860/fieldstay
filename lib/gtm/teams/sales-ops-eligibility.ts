/**
 * Whether an account should get a drafted outreach email, as a pure rule.
 *
 * Used twice and it must agree with itself: Rev Ops picks candidates with the
 * SQL form of it (DRAFTABLE_STAGES), and the Sales Ops handler re-checks the
 * live row before spending a model call, because the account can change between
 * the report being approved and the draft being written (someone replied, the
 * email bounced, a person closed it).
 *
 * The line it draws: a draft is for a prospect who has not answered. Once they
 * reply, what they need is a human reply to what they actually said, and a
 * templated follow-up to someone mid-conversation is worse than silence.
 */

/** Stages where we are still waiting on a first answer. */
export const DRAFTABLE_STAGES = ['queued', 'emailed', 'called', 'texted'] as const

const IN_CONVERSATION = ['replied', 'meeting_set', 'in_trial'] as const
const CLOSED = ['won', 'lost', 'disqualified'] as const

export type IneligibleReason = 'closed' | 'in_conversation' | 'not_ready' | 'no_email' | 'email_bounced'

export interface DraftTarget { status: string; email: string | null; email_status: string | null }

export function draftEligibility(target: DraftTarget): { ok: true } | { ok: false; reason: IneligibleReason } {
  if ((CLOSED as readonly string[]).includes(target.status)) return { ok: false, reason: 'closed' }
  if ((IN_CONVERSATION as readonly string[]).includes(target.status)) return { ok: false, reason: 'in_conversation' }
  if (!(DRAFTABLE_STAGES as readonly string[]).includes(target.status)) return { ok: false, reason: 'not_ready' }
  if (!target.email) return { ok: false, reason: 'no_email' }
  if (target.email_status === 'bounced') return { ok: false, reason: 'email_bounced' }
  return { ok: true }
}

export const INELIGIBLE_SUMMARY: Record<IneligibleReason, string> = {
  closed:          'The account is closed, so no draft was written.',
  in_conversation: 'The account has replied or is in a conversation, so it needs a person\'s reply rather than a drafted follow-up.',
  not_ready:       'The account is not at a stage that gets outreach drafts.',
  no_email:        'The account has no email address.',
  email_bounced:   'The primary email bounced, so no draft was written.',
}

/** Stages where having just emailed someone changes where the account stands. */
const BEFORE_FIRST_OUTREACH = ['new', 'researching', 'needs_contact_info', 'queued']

/**
 * The status an account moves to once a person has sent it a drafted email, or
 * null to leave it alone. Only an account that had not been reached yet becomes
 * 'emailed'. One that already replied, has a meeting or is in a trial must never
 * be moved BACK to 'emailed' by a follow-up going out.
 */
export function statusAfterManualSend(current: string): 'emailed' | null {
  return BEFORE_FIRST_OUTREACH.includes(current) ? 'emailed' : null
}
