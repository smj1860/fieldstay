import { PRODUCT_FACTS } from '../brand/voice'
import { normalizeStateCode } from '@/lib/scoring/friction'

/**
 * The call brief: what to read before phoning a property manager.
 *
 * Pure, and no model on purpose. The thing a brief is most tempted to do is
 * tell you what is wrong in someone's business, and the honest position is that
 * we do not know. So every guess here is built from a fact we actually hold
 * (their portfolio size, their market, their title), is labelled as a guess, and
 * is worded as a QUESTION to ask and listen to, never a problem to announce. A
 * model asked to "find the pain" will find some whether or not it exists.
 *
 * What the call may say about FieldStay is a pointer into PRODUCT_FACTS, never
 * free text, so a brief cannot promise anything the product line does not.
 */

export interface CallBriefFacts {
  company:        string
  city:           string | null
  state:          string | null
  market:         string | null
  pms:            string | null
  pmsNote:        string | null
  portfolioSize:  number | null
  contactName:    string | null
  contactTitle:   string | null
  emailIsGeneric: boolean
  hasPhone:       boolean
  /** Where the contact details came from, so "how did you get my number?" has a true answer. */
  source:         string | null
  status:         string
  /** The founder's own notes on the account. Quoted as written. */
  founderNotes:   string | null
  priorTouches:   { type: string; daysAgo: number }[]
}

export interface Hypothesis {
  id:       string
  theme:    string
  /** The fact this guess comes from. A guess with no stated basis is not allowed. */
  basis:    string
  /** Worded as a question. Always ends in a question mark. */
  question: string
  /** Index into PRODUCT_FACTS, or null when the right move is to listen and say nothing about FieldStay. */
  fact:     number | null
}

export interface CallBrief {
  headline:     string
  known:        string[]
  unknown:      string[]
  hypotheses:   Hypothesis[]
  honestyRules: string[]
  text:         string
}

/** Indexes into PRODUCT_FACTS. Named so a rule reads as what it points at. */
const FACT = { overview: 0, bookingsSync: 1, suggestions: 2, crewApp: 3, vendorLink: 4, setup: 5, ownerPnl: 6 } as const

export const MAX_HYPOTHESES = 5
const MAX_NOTES_CHARS = 400

export const HONESTY_RULES: readonly string[] = [
  'Say who you are and that you are calling out of the blue. Then ask if now is a bad time, and mean it.',
  'You are a person on this call. Do not record it unless they agree to it first.',
  'Everything under Guesses is a guess. Ask the question and listen. Never tell them these are their problems.',
  'Describe FieldStay only with the approved lines below. No customers, results, savings or prices.',
  'If they ask how you got their details, answer from the line that says where they came from. If it is not there, say you are not sure and offer to find out.',
  'If they say no, or ask you to stop, thank them, stop, and note it on the account.',
]

// ── facts ───────────────────────────────────────────────────────────────────

type SizeBand = 'solo' | 'growing' | 'established' | 'large'

export function sizeBand(portfolioSize: number | null): SizeBand | null {
  if (portfolioSize === null || portfolioSize < 1) return null
  if (portfolioSize <= 4) return 'solo'
  if (portfolioSize <= 15) return 'growing'
  if (portfolioSize <= 50) return 'established'
  return 'large'
}

/** States where a vacant property can genuinely freeze in winter, including the mountain South. */
const FREEZE_STATES: ReadonlySet<string> = new Set([
  'AK', 'CO', 'CT', 'DE', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MT',
  'NC', 'ND', 'NE', 'NH', 'NJ', 'NY', 'OH', 'PA', 'RI', 'SD', 'TN', 'UT', 'VA', 'VT', 'WI', 'WV', 'WY',
])

const OWNER_TITLE = /\b(?:owner|founder|co-?founder|principal|president|ceo|broker)\b/i
const OPS_TITLE = /\b(?:manager|coordinator|operations|ops|director|supervisor)\b/i

// ── the guesses ─────────────────────────────────────────────────────────────

interface Rule {
  applies: (f: CallBriefFacts) => boolean
  make:    (f: CallBriefFacts) => Hypothesis
}

const doors = (f: CallBriefFacts): string => `${f.portfolioSize ?? 'An unknown number of'} doors on record`

function pmsBasis(f: CallBriefFacts): string {
  const how = f.pmsNote ? ` (identified from: ${f.pmsNote})` : ''
  return `The system on record is ${f.pms}${how}`
}

const RULES: readonly Rule[] = [
  {
    applies: (f) => sizeBand(f.portfolioSize) === 'solo',
    make: (f) => ({
      id: 'solo-coverage', theme: 'Crew coverage', basis: doors(f), fact: FACT.suggestions,
      question: 'When a cleaner cancels at the last minute, what do you do, and who finds out first?',
    }),
  },
  {
    applies: (f) => sizeBand(f.portfolioSize) === 'solo' || sizeBand(f.portfolioSize) === 'growing',
    make: (f) => ({
      id: 'proof-of-clean', theme: 'Knowing a turnover was done right', basis: doors(f), fact: FACT.crewApp,
      question: 'When you are not there, how do you know a turnover was finished the way you would have done it?',
    }),
  },
  {
    applies: (f) => sizeBand(f.portfolioSize) === 'growing',
    make: (f) => ({
      id: 'booking-handoff', theme: 'Bookings reaching the crew', basis: doors(f), fact: FACT.bookingsSync,
      question: 'When a booking is made or changed, how does your cleaner find out?',
    }),
  },
  {
    applies: (f) => sizeBand(f.portfolioSize) === 'growing' || sizeBand(f.portfolioSize) === 'established',
    make: (f) => ({
      id: 'vendor-jobs', theme: 'Vendors and work orders', basis: doors(f), fact: FACT.vendorLink,
      question: 'When something breaks, how do you get a vendor out, and how do you keep track of the job and the invoice?',
    }),
  },
  {
    applies: (f) => sizeBand(f.portfolioSize) === 'established' || sizeBand(f.portfolioSize) === 'large',
    make: (f) => ({
      id: 'assigning', theme: 'Deciding who takes each turnover', basis: doors(f), fact: FACT.suggestions,
      question: 'Who decides which cleaner takes which turnover, and how long does that take you in a week?',
    }),
  },
  {
    applies: (f) => sizeBand(f.portfolioSize) === 'established' || sizeBand(f.portfolioSize) === 'large',
    make: (f) => ({
      id: 'owner-reporting', theme: 'Owner reporting', basis: doors(f), fact: FACT.ownerPnl,
      question: 'How do your owners get their numbers, and who puts them together?',
    }),
  },
  {
    applies: (f) => sizeBand(f.portfolioSize) === 'large',
    make: (f) => ({
      id: 'coverage-when-out', theme: 'Depending on one person', basis: doors(f), fact: FACT.overview,
      question: 'If you were out for a week, who could run the schedule, and how would they know what was going on?',
    }),
  },
  {
    applies: (f) => f.pms !== null && f.pms.trim() !== '',
    make: (f) => ({
      id: 'pms-to-crew', theme: 'Bookings to the crew', fact: FACT.bookingsSync,
      basis: pmsBasis(f),
      question: `Your bookings come in through ${f.pms}. How do they reach your cleaners today?`,
    }),
  },
  {
    applies: (f) => FREEZE_STATES.has(normalizeStateCode(f.state) ?? ''),
    make: (f) => ({
      id: 'vacant-freeze', theme: 'Vacant properties in a freeze', fact: null,
      basis: `The market is in ${normalizeStateCode(f.state)}, where a hard freeze is possible`,
      question: 'What is your routine for checking on vacant properties during a hard freeze?',
    }),
  },
  {
    applies: (f) => OWNER_TITLE.test(f.contactTitle ?? ''),
    make: (f) => ({
      id: 'owner-hands-on', theme: 'Who runs the day to day', fact: null,
      basis: `The title on record is "${f.contactTitle}"`,
      question: 'How much of the day-to-day operations do you still handle yourself?',
    }),
  },
  {
    applies: (f) => !OWNER_TITLE.test(f.contactTitle ?? '') && OPS_TITLE.test(f.contactTitle ?? ''),
    make: (f) => ({
      id: 'ops-reporting', theme: 'What the business asks of operations', fact: FACT.ownerPnl,
      basis: `The title on record is "${f.contactTitle}"`,
      question: 'What do the owners or the business ask you for, and how long does it take to pull together?',
    }),
  },
]

export function buildHypotheses(facts: CallBriefFacts): Hypothesis[] {
  return RULES.filter((r) => r.applies(facts)).map((r) => r.make(facts)).slice(0, MAX_HYPOTHESES)
}

// ── what we do not know ─────────────────────────────────────────────────────

function pmsUnknown(f: CallBriefFacts): string[] {
  if (f.pms === null || f.pms.trim() === '') return ['Which system they run bookings in.']
  return f.pmsNote ? ['Whether the system on record is right. It was inferred, not confirmed.'] : []
}

export function buildUnknowns(f: CallBriefFacts): string[] {
  const unknown = [...pmsUnknown(f)]
  if (sizeBand(f.portfolioSize) === null) unknown.push('How many properties they manage.')
  else unknown.push('Whether the portfolio size on record is right. Treat it as an estimate until they say it.')
  if (f.emailIsGeneric) unknown.push('Whether this contact decides on operations tools. The email on file is a shared inbox.')
  if (f.contactName === null || f.contactName.trim() === '') unknown.push('Who to ask for.')
  if (!f.hasPhone) unknown.push('A phone number. None is on file, so there is nobody to call yet.')
  unknown.push('Whether they have a problem with any of this. Nothing here says they do.')
  return unknown
}

// ── what we know ────────────────────────────────────────────────────────────

function whereLine(f: CallBriefFacts): string | null {
  const place = [f.city, f.state].filter((p): p is string => p !== null && p.trim() !== '').join(', ')
  return place === '' ? null : `Based in ${place}.`
}

function agoLabel(daysAgo: number): string {
  if (daysAgo === 0) return 'today'
  return `${daysAgo} days ago`
}

function touchLine(f: CallBriefFacts): string | null {
  if (f.priorTouches.length === 0) return null
  const parts = f.priorTouches.map((t) => `${t.type.replaceAll('_', ' ')} ${agoLabel(t.daysAgo)}`)
  return `Earlier contact from us: ${parts.join(', ')}. They have not necessarily read any of it, so do not act as if they have.`
}

function contactLine(f: CallBriefFacts): string | null {
  if (!f.contactName) return null
  const title = f.contactTitle ? `, ${f.contactTitle}` : ''
  return `Contact: ${f.contactName}${title}.`
}

export function buildKnown(f: CallBriefFacts): string[] {
  const lines: (string | null)[] = [
    `${f.company}.`,
    whereLine(f),
    f.portfolioSize === null ? null : `Portfolio size on record: ${f.portfolioSize}.`,
    f.pms ? `System on record: ${f.pms}.` : null,
    contactLine(f),
    `Stage: ${f.status.replaceAll('_', ' ')}.`,
    touchLine(f),
    f.source ? `Where their details came from: ${f.source}.` : null,
    f.founderNotes ? `Your notes: ${f.founderNotes.trim().slice(0, MAX_NOTES_CHARS)}` : null,
  ]
  return lines.filter((l): l is string => l !== null)
}

// ── assembly ────────────────────────────────────────────────────────────────

function bullets(items: readonly string[]): string[] {
  return items.map((i) => `- ${i}`)
}

function guessLines(hypotheses: readonly Hypothesis[]): string[] {
  if (hypotheses.length === 0) return ['Not enough is known to guess. Open with a plain question about how they run turnovers today.']
  return hypotheses.flatMap((h, i) => {
    const line = h.fact === null ? 'Listen only. Nothing approved to say about FieldStay here.' : `If it fits, you can say: ${PRODUCT_FACTS[h.fact]}`
    return [`${i + 1}. ${h.theme}`, `   Because: ${h.basis}.`, `   Ask: ${h.question}`, `   ${line}`]
  })
}

export function buildCallBrief(facts: CallBriefFacts): CallBrief {
  const hypotheses = buildHypotheses(facts)
  const known = buildKnown(facts)
  const unknown = buildUnknowns(facts)
  const headline = `Call brief: ${facts.company}`

  const text = [
    headline,
    '',
    'What we know',
    ...bullets(known),
    '',
    'What we do not know',
    ...bullets(unknown),
    '',
    'Guesses to ask about (guesses, not findings)',
    ...guessLines(hypotheses),
    '',
    'Keep it honest',
    ...bullets(HONESTY_RULES),
  ].join('\n')

  return { headline, known, unknown, hypotheses, honestyRules: [...HONESTY_RULES], text }
}
