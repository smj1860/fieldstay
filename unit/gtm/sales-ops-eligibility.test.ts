import { describe, it, expect } from 'vitest'
import { DRAFTABLE_STAGES, INELIGIBLE_SUMMARY, draftEligibility, statusAfterManualCall, statusAfterManualSend, statusAfterReply } from '@/lib/gtm/teams/sales-ops-eligibility'

const target = (over: Partial<{ status: string; email: string | null; email_status: string | null }> = {}) =>
  ({ status: 'queued', email: 'dana@acmerentals.com', email_status: 'unknown', ...over })

describe('draftEligibility', () => {
  it.each(DRAFTABLE_STAGES)('drafts for an account in %s that has a working email', (status) => {
    expect(draftEligibility(target({ status }))).toEqual({ ok: true })
  })

  // Once they answer, they need a person's reply to what they said, not a template.
  it.each(['replied', 'meeting_set', 'in_trial'])('never drafts a follow-up to someone already in conversation (%s)', (status) => {
    expect(draftEligibility(target({ status }))).toEqual({ ok: false, reason: 'in_conversation' })
  })

  it.each(['won', 'lost', 'disqualified'])('never drafts for a closed account (%s)', (status) => {
    expect(draftEligibility(target({ status }))).toEqual({ ok: false, reason: 'closed' })
  })

  it.each(['new', 'researching', 'needs_contact_info', 'visited_no_contact', 'mystery'])('does not draft at stage %s', (status) => {
    expect(draftEligibility(target({ status }))).toEqual({ ok: false, reason: 'not_ready' })
  })

  it('needs an email, and refuses one that bounced', () => {
    expect(draftEligibility(target({ email: null }))).toEqual({ ok: false, reason: 'no_email' })
    expect(draftEligibility(target({ email: '' }))).toEqual({ ok: false, reason: 'no_email' })
    expect(draftEligibility(target({ email_status: 'bounced' }))).toEqual({ ok: false, reason: 'email_bounced' })
    expect(draftEligibility(target({ email_status: 'valid' }))).toEqual({ ok: true })
  })

  it('reports the closed state before a missing email, so the reason is the one that matters', () => {
    expect(draftEligibility(target({ status: 'won', email: null }))).toMatchObject({ reason: 'closed' })
  })

  it('has a plain sentence for every reason, with no em dash', () => {
    for (const sentence of Object.values(INELIGIBLE_SUMMARY)) {
      expect(sentence.length).toBeGreaterThan(10)
      expect(sentence).not.toContain('—')
    }
  })
})

describe('statusAfterManualSend', () => {
  it.each(['new', 'researching', 'needs_contact_info', 'queued'])('moves an account that had not been reached (%s) to emailed', (status) => {
    expect(statusAfterManualSend(status)).toBe('emailed')
  })

  // Moving these back to "emailed" would erase a reply, a meeting or a trial from the funnel.
  it.each(['emailed', 'called', 'texted', 'replied', 'meeting_set', 'in_trial', 'won', 'lost', 'disqualified', 'mystery'])('leaves %s alone', (status) => {
    expect(statusAfterManualSend(status)).toBeNull()
  })
})

describe('statusAfterManualCall', () => {
  it.each(['new', 'researching', 'needs_contact_info', 'queued'])('moves an account that had not been reached (%s) to called', (status) => {
    expect(statusAfterManualCall(status)).toBe('called')
  })

  it.each(['emailed', 'called', 'texted', 'replied', 'meeting_set', 'in_trial', 'won', 'lost', 'disqualified'])('leaves %s alone', (status) => {
    expect(statusAfterManualCall(status)).toBeNull()
  })
})

describe('statusAfterReply', () => {
  it.each(['new', 'researching', 'needs_contact_info', 'queued', 'emailed', 'called', 'texted', 'visited_no_contact'])(
    'moves an account still waiting on an answer (%s) to replied', (status) => {
      expect(statusAfterReply(status)).toBe('replied')
    })

  // Moving these back to "replied" would erase a meeting or a trial; closing is a person's own call.
  it.each(['replied', 'meeting_set', 'in_trial', 'won', 'lost', 'disqualified', 'mystery'])('leaves %s alone', (status) => {
    expect(statusAfterReply(status)).toBeNull()
  })
})

describe('draftEligibility: meeting requests', () => {
  it.each(['new', 'researching', 'needs_contact_info', 'queued'])('lets a meeting request start from %s when there is an email', (status) => {
    expect(draftEligibility(target({ status }), 'meeting_request')).toEqual({ ok: true })
  })

  it('still refuses a conversation, a closed account, a missing email and a bounce', () => {
    expect(draftEligibility(target({ status: 'replied' }), 'meeting_request')).toMatchObject({ reason: 'in_conversation' })
    expect(draftEligibility(target({ status: 'lost' }), 'meeting_request')).toMatchObject({ reason: 'closed' })
    expect(draftEligibility(target({ status: 'new', email: null }), 'meeting_request')).toMatchObject({ reason: 'no_email' })
    expect(draftEligibility(target({ status: 'new', email_status: 'bounced' }), 'meeting_request')).toMatchObject({ reason: 'email_bounced' })
  })

  it('leaves the standard rule alone', () => {
    expect(draftEligibility(target({ status: 'new' }))).toEqual({ ok: false, reason: 'not_ready' })
  })
})
