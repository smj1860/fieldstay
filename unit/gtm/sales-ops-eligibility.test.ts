import { describe, it, expect } from 'vitest'
import { DRAFTABLE_STAGES, INELIGIBLE_SUMMARY, draftEligibility, statusAfterManualSend } from '@/lib/gtm/teams/sales-ops-eligibility'

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
