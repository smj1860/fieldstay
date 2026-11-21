import { MAX_SELF_SERVE_PROPERTIES } from '@/lib/stripe/brackets'

/**
 * Which accounts to move to "queued" (ready for a first outreach), and why. Pure:
 * no I/O, no model.
 *
 * THE CRITERIA are the founder's, set 2026-11-19: an account qualifies if it runs
 * OwnerRez, or if it is in a market on the founder's low-coverage list. Everything
 * else is left alone however well it would otherwise rank.
 *
 * Low cellular coverage is NOT derived. No account carries coverage data, and
 * guessing which markets have patchy service would put a claim in front of the
 * person approving that nobody can back. So it is a list the founder maintains
 * (LOW_COVERAGE_MARKETS), the same rule the seasonal-market table follows: a market
 * is added with a real basis, never a guess. While the list is empty only the
 * OwnerRez criterion matches, and the proposal says so rather than implying more.
 *
 * Hygiene is separate from criteria. A candidate also needs a working,
 * personal-looking email (nothing can be drafted without one), a portfolio inside
 * the self-serve range (200,000 properties is a data error, and past 150 is
 * Enterprise), and a stage before 'queued'.
 *
 * Within the qualifiers the order is by facts on the row, because the offline
 * scorer has not written a fit score to any account (score_a, score_b, track,
 * bucket and gate are all NULL), and a ranking invented to fill that gap would
 * read as judgment it does not have.
 */

/** The system the product integrates with and has a landing page for. Compared case-insensitively. */
export const OWNERREZ = 'OwnerRez'

/**
 * Markets the founder has put on the low-coverage list, matched on the account's
 * `market` exactly (case-insensitive). EMPTY until the founder names them: see the
 * header for why this is a list and not a guess. Add a market only on a real basis.
 */
export const LOW_COVERAGE_MARKETS: readonly string[] = []

/** Stages an account can be moved to 'queued' FROM. Anything further along is already someone's call. */
export const PRE_QUEUE_STATUSES = ['new', 'researching', 'needs_contact_info'] as const

/** How many accounts one proposal may ask to queue. A person reads every line. */
export const MAX_QUEUE_PROPOSAL = 10

/** A proposal is pointless while this many accounts are already waiting at 'queued'. */
export const QUEUE_POOL_TARGET = 10

/** How many candidate rows one run reads, oldest first. A bound, not a ranking. */
export const CANDIDATE_READ_LIMIT = 500

export const MIN_PORTFOLIO = 1
export const MAX_PORTFOLIO = MAX_SELF_SERVE_PROPERTIES

/** The range the product is built for, per the founder's target customer. Worth more than merely in range. */
export const SWEET_SPOT = { min: 10, max: 50 } as const

const WEIGHTS = { namedContact: 3, sweetSpot: 3, inRange: 1 } as const

export interface QueueCandidate {
  id:               string
  company:          string
  city:             string | null
  state:            string | null
  pms:              string | null
  market:           string | null
  portfolio_size:   number | null
  contact_name:     string | null
  email:            string | null
  email_is_generic: boolean
  email_status:     string | null
  status:           string
}

export interface RankedCandidate extends QueueCandidate { score: number; reasons: string[] }

const present = (value: string | null): boolean => value !== null && value.trim() !== ''

function sizeInRange(size: number | null): boolean {
  return size === null || (size >= MIN_PORTFOLIO && size <= MAX_PORTFOLIO)
}

const same = (a: string | null, b: string): boolean => a !== null && a.trim().toLowerCase() === b.trim().toLowerCase()

export function runsOwnerRez(c: Pick<QueueCandidate, 'pms'>): boolean {
  return same(c.pms, OWNERREZ)
}

/** Whether the account's market is on the founder's list. */
export function inLowCoverageMarket(c: Pick<QueueCandidate, 'market'>, list: readonly string[] = LOW_COVERAGE_MARKETS): boolean {
  return c.market !== null && list.some((m) => same(c.market, m))
}

/** Why an account matches the founder's criteria. Empty means it does not, and is never proposed. */
export function matchReasons(c: QueueCandidate, list: readonly string[] = LOW_COVERAGE_MARKETS): string[] {
  const reasons: string[] = []
  if (runsOwnerRez(c)) reasons.push('runs OwnerRez')
  if (inLowCoverageMarket(c, list)) reasons.push(`in ${c.market}, on your low-coverage list`)
  return reasons
}

/** Hygiene every candidate needs, whatever the criteria: a stage before queued, a usable email, a sane size. */
function passesHygiene(c: QueueCandidate): boolean {
  if (!(PRE_QUEUE_STATUSES as readonly string[]).includes(c.status)) return false
  if (!present(c.email) || c.email_is_generic || c.email_status === 'bounced') return false
  return sizeInRange(c.portfolio_size)
}

/** Whether an account may be proposed at all: it matches a criterion AND passes hygiene. */
export function isQueueable(c: QueueCandidate, list: readonly string[] = LOW_COVERAGE_MARKETS): boolean {
  return passesHygiene(c) && matchReasons(c, list).length > 0
}

function sizePoints(size: number | null): { points: number; reason: string | null } {
  if (size === null) return { points: 0, reason: null }
  if (size >= SWEET_SPOT.min && size <= SWEET_SPOT.max) return { points: WEIGHTS.sweetSpot, reason: `about ${size} properties` }
  return { points: WEIGHTS.inRange, reason: `${size} properties` }
}

const MATCH_POINTS = 5

export function scoreCandidate(c: QueueCandidate, list: readonly string[] = LOW_COVERAGE_MARKETS): { score: number; reasons: string[] } {
  const reasons = matchReasons(c, list)
  let score = reasons.length * MATCH_POINTS
  if (present(c.contact_name)) { score += WEIGHTS.namedContact; reasons.push('a named contact') }
  const size = sizePoints(c.portfolio_size)
  score += size.points
  if (size.reason) reasons.push(size.reason)
  return { score, reasons }
}

/** Queueable accounts, best first. Ties break on company name so the order is stable between runs. */
export function rankCandidates(rows: readonly QueueCandidate[], list: readonly string[] = LOW_COVERAGE_MARKETS): RankedCandidate[] {
  return rows
    .filter((c) => isQueueable(c, list))
    .map((c) => ({ ...c, ...scoreCandidate(c, list) }))
    .sort((a, b) => b.score - a.score || a.company.localeCompare(b.company))
}

function placeOf(c: Pick<QueueCandidate, 'city' | 'state'>): string {
  const place = [c.city, c.state].filter((p): p is string => p !== null && p.trim() !== '').join(', ')
  return place === '' ? '' : ` (${place})`
}

export interface QueueProposalText { subject: string; body: string; summary: string }

/** What the person approving reads. No email addresses: the line says who, where and why. */
export function describeProposal(ranked: readonly RankedCandidate[], alreadyQueued: number): QueueProposalText {
  const noun = ranked.length === 1 ? 'account' : 'accounts'
  const lines = ranked.map((c, i) => `${i + 1}. ${c.company}${placeOf(c)}: ${c.reasons.join(', ')}`)
  const body = [
    `Move these ${ranked.length} ${noun} to queued, so the next report can ask for a first email to each.`,
    '',
    ...lines,
    '',
    'How they were chosen: each runs OwnerRez or is in a market on the low-coverage list, and has a working,',
    'personal-looking email and a portfolio within the self-serve range. They are ranked by what is on the account',
    '(both criteria, a named contact, a size near 10 to 50 properties), because no fit score has been written yet.',
    'Nothing is emailed by approving this.',
  ].join('\n')
  const waiting = alreadyQueued === 0 ? 'None are queued yet.' : `${alreadyQueued} already queued.`
  return {
    subject: `Queue ${ranked.length} ${noun} for outreach`,
    body,
    summary: `${ranked.length} ${noun} ready to move to queued. ${waiting} Approving only changes their stage.`,
  }
}
