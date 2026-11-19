import { describe, it, expect } from 'vitest'
import { PRODUCT_FACTS, checkDraft } from '@/lib/gtm/brand/voice'
import {
  HONESTY_RULES, MAX_HYPOTHESES, buildCallBrief, buildHypotheses, buildUnknowns, sizeBand, type CallBriefFacts,
} from '@/lib/gtm/teams/sales-ops-call-brief'

const facts = (over: Partial<CallBriefFacts> = {}): CallBriefFacts => ({
  company: 'Acme Rentals', city: 'Dadeville', state: 'AL', market: null, pms: 'OwnerRez', pmsNote: null,
  portfolioSize: 30, contactName: 'Dana Smith', contactTitle: 'Owner', emailIsGeneric: false, hasPhone: true,
  source: 'STRScout import', status: 'emailed', founderNotes: null, priorTouches: [], ...over,
})

describe('sizeBand', () => {
  it.each([[null, null], [0, null], [1, 'solo'], [4, 'solo'], [5, 'growing'], [15, 'growing'], [16, 'established'], [50, 'established'], [51, 'large'], [400, 'large']] as const)(
    '%s doors is %s', (n, band) => { expect(sizeBand(n)).toBe(band) })
})

describe('the guesses', () => {
  const all = (over: Partial<CallBriefFacts> = {}) => buildHypotheses(facts(over))

  it('every guess is worded as a question and states the fact it comes from', () => {
    const sizes = [1, 3, 8, 12, 30, 45, 80, 300]
    for (const portfolioSize of sizes) {
      for (const h of all({ portfolioSize, state: 'MN', contactTitle: 'Owner' })) {
        expect(h.question.trim().endsWith('?'), h.id).toBe(true)
        expect(h.basis.trim().length, h.id).toBeGreaterThan(5)
      }
    }
  })

  it('only ever points at an approved product line, never free text', () => {
    for (const portfolioSize of [2, 8, 30, 90]) {
      for (const h of all({ portfolioSize, state: 'TN' })) {
        if (h.fact !== null) expect(PRODUCT_FACTS[h.fact], h.id).toBeDefined()
      }
    }
  })

  it('never states a problem: no guess question or basis uses a banned honesty phrase', () => {
    const phrases = [...all({ portfolioSize: 8, state: 'MN' }), ...all({ portfolioSize: 80 }), ...all({ portfolioSize: 30 })]
    for (const h of phrases) {
      const lower = `${h.question} ${h.basis}`.toLowerCase()
      for (const bad of ['you are losing', "you're losing", 'costing you', 'you probably', 'struggling', 'must be']) {
        expect(lower, h.id).not.toContain(bad)
      }
    }
  })

  it('varies with the size of the portfolio', () => {
    expect(all({ portfolioSize: 2 }).map((h) => h.id)).toContain('solo-coverage')
    expect(all({ portfolioSize: 9 }).map((h) => h.id)).toContain('booking-handoff')
    expect(all({ portfolioSize: 30 }).map((h) => h.id)).toContain('owner-reporting')
    expect(all({ portfolioSize: 120 }).map((h) => h.id)).toContain('coverage-when-out')
    expect(all({ portfolioSize: 2 }).map((h) => h.id)).not.toContain('owner-reporting')
  })

  it('asks about the system on record, and says where that came from when it was inferred', () => {
    const inferred = all({ pms: 'Guesty', pmsNote: 'booking widget on their site' }).find((h) => h.id === 'pms-to-crew')!
    expect(inferred.basis).toContain('booking widget on their site')
    expect(inferred.question).toContain('Guesty')
    expect(all({ pms: null }).map((h) => h.id)).not.toContain('pms-to-crew')
    expect(all({ pms: '  ' }).map((h) => h.id)).not.toContain('pms-to-crew')
  })

  it('raises a freeze only where a freeze is possible, and says nothing about FieldStay when it does', () => {
    const cold = all({ state: 'Minnesota' }).find((h) => h.id === 'vacant-freeze')!
    expect(cold.fact).toBeNull()
    expect(all({ state: 'FL' }).map((h) => h.id)).not.toContain('vacant-freeze')
    expect(all({ state: null }).map((h) => h.id)).not.toContain('vacant-freeze')
  })

  it('reads the title once: an owner gets one question, an operations title gets the other', () => {
    expect(all({ contactTitle: 'Owner' }).map((h) => h.id)).toContain('owner-hands-on')
    expect(all({ contactTitle: 'Operations Manager' }).map((h) => h.id)).toContain('ops-reporting')
    const both = all({ contactTitle: 'Owner and Operations Manager' }).map((h) => h.id)
    expect(both).toContain('owner-hands-on')
    expect(both).not.toContain('ops-reporting')
    expect(all({ contactTitle: null }).map((h) => h.id)).not.toContain('owner-hands-on')
  })

  it('stays within the cap, and guesses nothing from nothing', () => {
    expect(all({ portfolioSize: 30, state: 'MN', contactTitle: 'Owner' }).length).toBeLessThanOrEqual(MAX_HYPOTHESES)
    expect(all({ portfolioSize: null, pms: null, state: null, contactTitle: null })).toEqual([])
  })
})

describe('what we do not know', () => {
  it('always says that nothing shows they have a problem', () => {
    expect(buildUnknowns(facts()).at(-1)).toMatch(/Nothing here says they do/)
  })

  it('names each gap', () => {
    const gaps = buildUnknowns(facts({ pms: null, portfolioSize: null, emailIsGeneric: true, contactName: null, hasPhone: false })).join('\n')
    expect(gaps).toContain('Which system')
    expect(gaps).toContain('How many properties')
    expect(gaps).toContain('shared inbox')
    expect(gaps).toContain('Who to ask for')
    expect(gaps).toContain('None is on file')
  })

  it('treats an inferred system and a recorded size as unconfirmed', () => {
    const gaps = buildUnknowns(facts({ pmsNote: 'widget' })).join('\n')
    expect(gaps).toContain('inferred, not confirmed')
    expect(gaps).toContain('estimate until they say it')
  })
})

describe('buildCallBrief', () => {
  it('puts what we know, what we do not, the guesses and the honesty rules in one readable text', () => {
    const { text } = buildCallBrief(facts())
    for (const heading of ['What we know', 'What we do not know', 'Guesses to ask about', 'Keep it honest']) expect(text).toContain(heading)
    for (const rule of HONESTY_RULES) expect(text).toContain(rule)
  })

  it('says where the contact details came from, so "how did you get my number" has a true answer', () => {
    expect(buildCallBrief(facts()).text).toContain('Where their details came from: STRScout import.')
    expect(buildCallBrief(facts({ source: null })).text).not.toContain('Where their details came from')
  })

  it('warns that earlier contact is not the same as being read', () => {
    const { text } = buildCallBrief(facts({ priorTouches: [{ type: 'emailed', daysAgo: 6 }, { type: 'texted', daysAgo: 0 }] }))
    expect(text).toContain('emailed 6 days ago, texted today')
    expect(text).toMatch(/do not act as if they have/)
  })

  it('quotes the founder\'s notes, trimmed', () => {
    expect(buildCallBrief(facts({ founderNotes: '  met at the conference  ' })).text).toContain('Your notes: met at the conference')
    expect(buildCallBrief(facts({ founderNotes: 'x'.repeat(2000) })).text.length).toBeLessThan(6000)
  })

  it('says to open with a plain question when there is nothing to guess from', () => {
    const { text, hypotheses } = buildCallBrief(facts({ portfolioSize: null, pms: null, state: null, contactTitle: null }))
    expect(hypotheses).toEqual([])
    expect(text).toContain('Not enough is known to guess')
  })

  it('offers an approved line only when it fits, and says to just listen otherwise', () => {
    const { text } = buildCallBrief(facts({ portfolioSize: null, pms: null, state: 'MN', contactTitle: null }))
    expect(text).toContain('Listen only. Nothing approved to say about FieldStay here.')
  })

  // The house rules apply to everything we write, including what only the founder reads.
  it('uses no dash as punctuation and no exclamation mark anywhere', () => {
    for (const portfolioSize of [null, 2, 9, 30, 120]) {
      const { text } = buildCallBrief(facts({ portfolioSize, state: 'MN', contactTitle: 'Owner', priorTouches: [{ type: 'emailed', daysAgo: 3 }] }))
      expect(text).not.toMatch(/[—–]| -- /)
      expect(text).not.toContain('!')
    }
  })

  it('never quotes a price or promises a result', () => {
    const { text } = buildCallBrief(facts({ portfolioSize: 30, state: 'MN', contactTitle: 'Owner' }))
    const issues = checkDraft({ subject: 'x', body: `Hi there, ${text}` }).map((i) => i.rule)
    expect(issues).not.toContain('pricing')
    expect(issues).not.toContain('unbacked_claim')
    expect(issues).not.toContain('social_proof')
  })

  it('carries no phone number or email address: only whether a phone is on file', () => {
    const { text } = buildCallBrief(facts({ hasPhone: true }))
    expect(text).not.toMatch(/\d{3}[-. ]\d{3}[-. ]\d{4}/)
    expect(text).not.toContain('@')
  })
})
