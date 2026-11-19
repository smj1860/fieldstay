import { describe, it, expect } from 'vitest'
import {
  LOW_COVERAGE_MARKETS, MAX_PORTFOLIO, MAX_QUEUE_PROPOSAL, OWNERREZ, PRE_QUEUE_STATUSES, describeProposal, inLowCoverageMarket,
  isQueueable, matchReasons, rankCandidates, runsOwnerRez, scoreCandidate, type QueueCandidate,
} from '@/lib/gtm/teams/queue-candidates'

const MARKETS = ['Smoky Mountains', 'Estes Park']

const cand = (over: Partial<QueueCandidate> = {}): QueueCandidate => ({
  id: 'a1', company: 'Acme Rentals', city: 'Dadeville', state: 'AL', pms: OWNERREZ, market: null, portfolio_size: 20,
  contact_name: 'Dana Smith', email: 'dana@acmerentals.com', email_is_generic: false, email_status: 'unknown', status: 'new', ...over,
})

describe('the criteria: OwnerRez, or a market on the founder\'s list', () => {
  it('ships with an EMPTY market list, because no basis for any market has been given', () => {
    expect(LOW_COVERAGE_MARKETS).toEqual([])
  })

  it('matches an account that runs OwnerRez, in any case and with stray spaces', () => {
    for (const pms of ['OwnerRez', 'ownerrez', '  OWNERREZ ']) expect(runsOwnerRez({ pms })).toBe(true)
    for (const pms of ['Guesty', 'OwnerRez Pro', null]) expect(runsOwnerRez({ pms })).toBe(false)
  })

  it('matches a market on the list exactly, never a near neighbour or a substring', () => {
    expect(inLowCoverageMarket({ market: 'smoky mountains' }, MARKETS)).toBe(true)
    expect(inLowCoverageMarket({ market: 'Smoky Mountains ' }, MARKETS)).toBe(true)
    expect(inLowCoverageMarket({ market: 'Smoky' }, MARKETS)).toBe(false)
    expect(inLowCoverageMarket({ market: 'Gatlinburg' }, MARKETS)).toBe(false)
    expect(inLowCoverageMarket({ market: null }, MARKETS)).toBe(false)
  })

  it('matches nothing in a market while the list is empty', () => {
    expect(inLowCoverageMarket({ market: 'Smoky Mountains' })).toBe(false)
  })

  it('says which criterion matched, in words the approver can check on the account', () => {
    expect(matchReasons(cand(), MARKETS)).toEqual(['runs OwnerRez'])
    expect(matchReasons(cand({ pms: 'Guesty', market: 'Estes Park' }), MARKETS)).toEqual(['in Estes Park, on your low-coverage list'])
    expect(matchReasons(cand({ market: 'Estes Park' }), MARKETS)).toHaveLength(2)
  })

  // The founder's rule: an account that is neither is never proposed, however good it looks otherwise.
  it('never proposes an account that matches neither criterion', () => {
    const lookerOtherwise = cand({ pms: 'Guesty', market: 'Nashville', contact_name: 'Dana', portfolio_size: 25 })
    expect(isQueueable(lookerOtherwise, MARKETS)).toBe(false)
    expect(rankCandidates([lookerOtherwise], MARKETS)).toEqual([])
  })
})

describe('hygiene every candidate needs, whatever the criteria', () => {
  it.each(PRE_QUEUE_STATUSES)('accepts an account at %s', (status) => {
    expect(isQueueable(cand({ status }), MARKETS)).toBe(true)
  })

  it.each(['queued', 'emailed', 'called', 'texted', 'replied', 'meeting_set', 'in_trial', 'won', 'lost', 'disqualified'])(
    'refuses an account already at %s', (status) => {
      expect(isQueueable(cand({ status }), MARKETS)).toBe(false)
    })

  it.each([
    ['no email', { email: null }],
    ['a blank email', { email: '  ' }],
    ['a role inbox', { email_is_generic: true }],
    ['a bounced email', { email_status: 'bounced' }],
  ])('refuses an account with %s', (_label, over) => {
    expect(isQueueable(cand(over), MARKETS)).toBe(false)
  })

  it('keeps the self-serve range, and treats an unknown size as fine', () => {
    expect(isQueueable(cand({ portfolio_size: 1 }), MARKETS)).toBe(true)
    expect(isQueueable(cand({ portfolio_size: MAX_PORTFOLIO }), MARKETS)).toBe(true)
    expect(isQueueable(cand({ portfolio_size: MAX_PORTFOLIO + 1 }), MARKETS)).toBe(false)
    expect(isQueueable(cand({ portfolio_size: 200_000 }), MARKETS)).toBe(false)
    expect(isQueueable(cand({ portfolio_size: 0 }), MARKETS)).toBe(false)
    expect(isQueueable(cand({ portfolio_size: null }), MARKETS)).toBe(true)
  })
})

describe('ranking within the qualifiers', () => {
  it('puts both criteria first, then a named contact, then a size near the sweet spot', () => {
    const both = cand({ id: 'both', company: 'Both', market: 'Estes Park', contact_name: null, portfolio_size: null })
    const named = cand({ id: 'named', company: 'Named', contact_name: 'Dana', portfolio_size: null })
    const sized = cand({ id: 'sized', company: 'Sized', contact_name: null, portfolio_size: 30 })
    const bare = cand({ id: 'bare', company: 'Bare', contact_name: null, portfolio_size: null })
    expect(rankCandidates([bare, sized, named, both], MARKETS).map((c) => c.id)).toEqual(['both', 'named', 'sized', 'bare'])
  })

  it('breaks ties on company name so the order is the same every run', () => {
    const rows = ['Zed', 'Alpha', 'Mid'].map((company, i) => cand({ id: `x${i}`, company, contact_name: null, portfolio_size: null }))
    expect(rankCandidates(rows, MARKETS).map((c) => c.company)).toEqual(['Alpha', 'Mid', 'Zed'])
  })

  it('reports every reason, and states a size as a fact', () => {
    const { reasons } = scoreCandidate(cand({ contact_name: 'Dana', portfolio_size: 30 }), MARKETS)
    expect(reasons).toEqual(['runs OwnerRez', 'a named contact', 'about 30 properties'])
    expect(scoreCandidate(cand({ portfolio_size: 80 }), MARKETS).reasons).toContain('80 properties')
  })
})

describe('describeProposal', () => {
  const ranked = () => rankCandidates([cand(), cand({ id: 'a2', company: 'Beta Stays', city: null, state: null })], MARKETS)

  it('lists who, where and why, and carries no email address', () => {
    const { body, subject, summary } = describeProposal(ranked(), 3)
    expect(body).toContain('1. Acme Rentals (Dadeville, AL): runs OwnerRez')
    expect(body).toContain('2. Beta Stays: runs OwnerRez')
    expect(body).not.toContain('@')
    expect(subject).toBe('Queue 2 accounts for outreach')
    expect(summary).toContain('3 already queued')
    expect(summary).toContain('only changes their stage')
  })

  it('states the criteria, and says approving emails nobody', () => {
    const { body } = describeProposal(ranked(), 0)
    expect(body).toMatch(/runs OwnerRez or is in a market on the low-coverage list/)
    expect(body).toContain('Nothing is emailed by approving this.')
  })

  it('uses the singular for one account, and says none are queued when none are', () => {
    const one = describeProposal(ranked().slice(0, 1), 0)
    expect(one.subject).toBe('Queue 1 account for outreach')
    expect(one.summary).toContain('None are queued yet.')
  })

  it('uses no dash as punctuation and no exclamation mark', () => {
    const { body, subject, summary } = describeProposal(ranked(), 2)
    expect(`${subject}${body}${summary}`).not.toMatch(/[—–]| -- |!/)
  })

  it('is bounded by the proposal cap', () => {
    expect(MAX_QUEUE_PROPOSAL).toBeLessThanOrEqual(10)
  })
})
