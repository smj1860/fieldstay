/**
 * FieldStay's outbound voice, as something a program can check.
 *
 * STATUS: DRAFT. Derived from the homepage copy and the house rules already in
 * this repo (no em dashes, "starting at" pricing). It has NOT been reviewed by
 * the founder. This file is the one place to edit it: the tone guidance below
 * goes into every drafting prompt, and the rules in checkDraft() are the hard
 * gate a draft must pass before anyone is asked to look at it. Bump
 * VOICE_GUIDE_VERSION when either changes, so every stored draft says which
 * version of the voice produced it.
 *
 * Two halves on purpose. The tone guidance is advice to a model and can be
 * ignored; the checks are code and cannot. Anything that must hold goes in the
 * checks.
 *
 * Pure: no I/O, so the rules are pinned by tests and safe to import anywhere.
 */

export const VOICE_GUIDE_VERSION = 'draft-3'

/** What the guide has and has not been through. Shown on the dashboard, so nobody mistakes it for approved. */
export const VOICE_GUIDE_STATUS = 'Draft. Derived from the homepage copy, with honesty rules and the founder\'s tone notes; not yet reviewed by the founder in full, product facts unconfirmed.'

/**
 * The only things a draft may say about the product. A model asked to write a
 * sales email will happily invent a feature, a number or a customer, and none of
 * that can be taken back once it is sent. Every line here is already public on
 * the homepage. Add to the list deliberately; do not loosen the prompt instead.
 */
export const PRODUCT_FACTS: readonly string[] = [
  'FieldStay handles crew scheduling, turnovers, maintenance, inventory, vendor work orders and guest communications for short-term rental property managers.',
  'Bookings sync in from the property management system and calendars, and the turnovers are created automatically.',
  'FieldStay suggests who should take each turnover, and why, so the manager accepts instead of figuring it out.',
  'Cleaners use a phone app with a room-by-room checklist. It works offline, and photos and counts upload later on their own.',
  'A vendor gets a link to the job, sees the work order, and invoices from their phone. They never make an account.',
  'Setting up a property takes about 15 minutes.',
  'Owners can see their own profit and loss.',
]

/**
 * The only things a draft may claim about the SENDER. Narrow on purpose: the
 * sender has done turnovers, not run a portfolio for years, and a draft that
 * says more than that is claiming experience nobody has. Add to the list only
 * with the sender's own word that it is true.
 */
export const SENDER_FACTS: readonly string[] = [
  'The sender has done turnovers themselves. That is the whole of the operating experience that may be claimed. Never say or imply they ran a portfolio, managed properties, or worked in the business for years.',
]

/** Advice to the drafting model. Not enforced: see checkDraft() for what is. */
export const VOICE_GUIDE: readonly string[] = [
  'Be genuine and honest above everything else. If a sentence is not true, or cannot be shown to be, it does not go in, however well it would land.',
  'Say plainly that you are writing without having spoken before, or that you wrote before and have not heard back. Never imply a relationship, a conversation or a reply that did not happen.',
  'You do not know their problems. Ask about them in a question, or name one as something common in the trade; never tell someone what is going wrong in their own business.',
  'End with a sincere way out: if this is not useful, they can say so and you will stop.',
  'Write the way one working operator writes to another. Plain, specific and short.',
  'Lead with something true and concrete about their business (their market, the size of their portfolio, the system they use), only if it was given to you. Never invent a detail about them.',
  'One idea per email. Say what the problem is in their terms (turnovers, crew, vendors, owner reports), then one sentence on how FieldStay takes it off their plate.',
  'Talk human to human, operator to operator, in their own terms (turnovers, crew, vendors, owner reports). That alone shows you know their time is short; when it comes naturally, say so plainly too.',
  'Sound like you know the work, because the sender has done turnovers. Speak from knowing the routine, never from a claim about this person or about how much experience the sender has.',
  'Say it straight. If a sentence is there to impress, cut it.',
  'Short sentences. No jargon, no hype, no exclamation marks, no emoji.',
  'Sound like a person with a calm view of the work, not a marketer. Never pressure. Never imply urgency that does not exist.',
  'End with one low-effort question or an offer to show them, and stop.',
  'Do not sign off with a name or a signature. The sender adds their own.',
]

// ── checks ──────────────────────────────────────────────────────────────────

export type VoiceRule =
  | 'em_dash' | 'subject_length' | 'subject_style' | 'body_length' | 'banned_phrase' | 'pricing'
  | 'link' | 'placeholder' | 'greeting' | 'exclamation' | 'signature' | 'emoji'
  | 'false_familiarity' | 'sender_overclaim' | 'pressure' | 'presumed_problem' | 'social_proof' | 'unbacked_claim' | 'opt_out'

export interface VoiceIssue { rule: VoiceRule; detail: string }

export interface DraftText { subject: string; body: string }

export interface DraftContext {
  /** The recipient's first name when it is known. Decides the greeting. */
  firstName?: string | null
}

export const MAX_SUBJECT_CHARS = 60
export const MIN_BODY_WORDS = 25
export const MAX_BODY_WORDS = 150

/**
 * Phrases that read as a template, or as hype, or as a claim nobody can back.
 * Matched case-insensitively, as whole words or phrases.
 */
export const BANNED_PHRASES: readonly string[] = [
  'i hope this email finds you', 'hope you are doing well', 'hope you\'re doing well',
  'just checking in', 'circling back', 'touch base', 'following up on my last',
  'synergy', 'game-changer', 'game changer', 'revolutionary', 'cutting-edge', 'cutting edge',
  'leverage', 'unlock', 'supercharge', 'streamline your', 'take your business to the next level',
  'limited time', 'act now', 'don\'t miss out', 'once in a lifetime',
  'guarantee', 'guaranteed', '100%', 'risk-free', 'no obligation',
  'best in class', 'best-in-class', 'world-class', 'industry-leading', 'industry leading',
  '#1', 'number one', 'the best', 'leading provider',
]

/**
 * The honesty rules. Each list is a way of saying something we cannot stand
 * behind: a look at their business nobody took, a conversation that never
 * happened, a deadline that does not exist, a problem we are only guessing at,
 * customers we have not been given leave to cite. Matched case-insensitively
 * as phrases. A hit is a failed draft, not a warning.
 */
export const FALSE_FAMILIARITY: readonly string[] = [
  'i noticed', 'i saw your', 'i saw that', 'i came across', 'came across your', 'been following',
  'i looked at your', 'i looked through your', 'i read your', 'i reviewed your', 'love what you', 'loved what you',
  'as discussed', 'as we discussed', 'per our conversation', 'our last conversation', 'we spoke', 'we talked',
  'great to meet', 'nice to meet', 'as promised', 'as a fellow',
]
export const SENDER_OVERCLAIM: readonly string[] = [
  'years of experience', 'years in the business', 'years in this business', 'decades', 'i managed', 'i\'ve managed',
  'i have managed', 'i ran a', 'i\'ve run a', 'as a property manager', 'as an operator', 'i\'ve been there',
  'i have been there', 'been in your shoes', 'walked in your shoes', 'i know exactly',
]
export const PRESSURE: readonly string[] = [
  'urgent', 'asap', 'today only', 'this week only', 'last chance', 'running out', 'spots left', 'only a few',
  'before it\'s too late', 'quick question', 'quick call', 'just a quick',
]
export const PRESUMED_PROBLEM: readonly string[] = [
  'you\'re losing', 'you are losing', 'costing you', 'you\'re struggling', 'you are struggling', 'you\'re wasting',
  'you are wasting', 'you probably', 'i\'m sure you', 'i am sure you', 'you must be', 'you surely',
]
export const SOCIAL_PROOF: readonly string[] = [
  'trusted by', 'our customers', 'our clients', 'other property managers', 'other managers', 'managers like you',
  'customers say', 'customers love', 'thousands of', 'hundreds of', 'many managers', 'managers already',
]

/** A digit, an optional space, then %: "15%" and "2.5%" both end this way. No leading \d+, which would rescan a long digit run from every start. */
const PERCENT = /\d\s?%/
const SAVE_WORDS: ReadonlySet<string> = new Set(['save', 'saves', 'saved', 'saving'])
const CUT_WORDS: ReadonlySet<string> = new Set(['cut', 'cuts', 'reduce', 'reduces', 'reduced'])
const SAVED_THINGS: ReadonlySet<string> = new Set(['hours', 'time', 'money', 'days'])
/** How many words after "save" or "cut" still count as the same claim. */
const CLAIM_WINDOW = 5

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9']+/g) ?? []

/** "save you hours", "saves time": a saving nobody has measured. Word-based on purpose: no backtracking on a model's output. */
function claimsSaving(words: readonly string[]): boolean {
  return words.some((w, i) => SAVE_WORDS.has(w) && words.slice(i + 1, i + 1 + CLAIM_WINDOW).some((x) => SAVED_THINGS.has(x)))
}

/** "cuts turnover time by 30 minutes": a reduction with a number nobody has measured. */
function claimsReduction(words: readonly string[]): boolean {
  return words.some((w, i) => {
    if (!CUT_WORDS.has(w)) return false
    const window = words.slice(i + 1, i + 1 + CLAIM_WINDOW)
    const by = window.indexOf('by')
    return by >= 0 && /^\d/.test(window[by + 1] ?? '')
  })
}

function hasUnbackedClaim(text: string): boolean {
  if (PERCENT.test(text)) return true
  const words = wordsOf(text)
  return claimsSaving(words) || claimsReduction(words)
}

const OPT_OUT = /\b(?:tell me|let me know|say so|just say|reply)\b[^.?!]{0,80}\b(?:stop|won't|will not|not (?:useful|relevant|a fit|interested)|no thanks)\b/i

const DASHES = /[—–]| -- /
const EMOJI = /\p{Extended_Pictographic}/u
const PRICE = /\$\s?\d|\b\d[\d,.]*\s?(?:dollars|usd)\b/i
const URL_LIKE = /\bhttps?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+/gi
const PLACEHOLDER = /\[[^\]\n]{1,40}\]|\{\{[^}\n]{0,80}\}\}|<[a-z][a-z _-]{1,30}>|\bTODO\b|\bXXX\b/i
const SIGNOFFS: ReadonlySet<string> = new Set(['best', 'best regards', 'regards', 'kind regards', 'sincerely', 'cheers', 'thanks', 'thank you', 'warmly'])
const FAKE_THREAD = /^\s*(?:re|fwd?)\s*:/i

/** A line that is only a sign-off. Line by line, because a multiline regex over blank lines can scan quadratically. */
function hasSignoffLine(body: string): boolean {
  return body.split('\n').some((line) => SIGNOFFS.has(line.trim().toLowerCase().replace(/[,.!]$/, '')))
}

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length

function hostOf(url: string): string | null {
  try { return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase() } catch { return null }
}

const isOwnHost = (host: string): boolean => host === 'fieldstay.app' || host.endsWith('.fieldstay.app')

function lengthIssues(draft: DraftText): VoiceIssue[] {
  const issues: VoiceIssue[] = []
  const subject = draft.subject.trim()
  if (subject === '' || subject.length > MAX_SUBJECT_CHARS) {
    issues.push({ rule: 'subject_length', detail: `The subject must be 1 to ${MAX_SUBJECT_CHARS} characters; it is ${subject.length}.` })
  }
  const words = wordCount(draft.body)
  if (words < MIN_BODY_WORDS || words > MAX_BODY_WORDS) {
    issues.push({ rule: 'body_length', detail: `The body must be ${MIN_BODY_WORDS} to ${MAX_BODY_WORDS} words; it is ${words}.` })
  }
  return issues
}

function subjectIssues(subject: string): VoiceIssue[] {
  const issues: VoiceIssue[] = []
  if (subject.includes('!')) issues.push({ rule: 'subject_style', detail: 'The subject has an exclamation mark.' })
  if (/\b[A-Z]{4,}\b/.test(subject)) issues.push({ rule: 'subject_style', detail: 'The subject has a word in capitals.' })
  // A subject that pretends to be part of an existing thread is a deceptive subject line.
  if (FAKE_THREAD.test(subject)) issues.push({ rule: 'subject_style', detail: 'The subject starts with Re: or Fwd:, which pretends there was a thread.' })
  return issues
}

function phraseIssues(text: string): VoiceIssue[] {
  const lower = text.toLowerCase()
  return BANNED_PHRASES.filter((p) => lower.includes(p)).map((p) => ({ rule: 'banned_phrase' as const, detail: `Uses the phrase "${p}".` }))
}

function linkIssues(text: string): VoiceIssue[] {
  const hosts = (text.match(URL_LIKE) ?? []).map(hostOf)
  const foreign = hosts.filter((h): h is string => h === null || !isOwnHost(h))
  return foreign.length > 0 ? [{ rule: 'link', detail: 'Links to somewhere other than fieldstay.app.' }] : []
}

function greetingIssue(body: string, firstName: string | null | undefined): VoiceIssue[] {
  const start = body.trimStart().toLowerCase()
  const name = firstName?.trim().toLowerCase()
  if (name) {
    return start.startsWith(`hi ${name},`) ? [] : [{ rule: 'greeting', detail: `The body must open with "Hi ${firstName},".` }]
  }
  return start.startsWith('hi there,') ? [] : [{ rule: 'greeting', detail: 'No first name is known, so the body must open with "Hi there,".' }]
}

function phraseRule(text: string, list: readonly string[], rule: VoiceRule, why: string): VoiceIssue[] {
  const lower = text.toLowerCase()
  return list.filter((p) => lower.includes(p)).map((p) => ({ rule, detail: `Uses "${p}". ${why}` }))
}

function honestyIssues(all: string, body: string): VoiceIssue[] {
  const issues = [
    ...phraseRule(all, FALSE_FAMILIARITY, 'false_familiarity', 'Do not claim to have looked at their business or to know them. Only say what you were given.'),
    ...phraseRule(all, SENDER_OVERCLAIM, 'sender_overclaim', 'The sender has done turnovers and may say so, but never claim more experience than that.'),
    ...phraseRule(all, PRESSURE, 'pressure', 'No urgency or "quick" framing. Nothing here is urgent.'),
    ...phraseRule(all, PRESUMED_PROBLEM, 'presumed_problem', 'You do not know their problems. Ask a question instead of stating one.'),
    ...phraseRule(all, SOCIAL_PROOF, 'social_proof', 'Do not cite customers or other managers. Say only what the product does.'),
  ]
  if (hasUnbackedClaim(all)) issues.push({ rule: 'unbacked_claim', detail: 'States a percentage or a saving nobody has measured. Say what the product does, not what it will save them.' })
  if (!OPT_OUT.test(body)) issues.push({ rule: 'opt_out', detail: 'Add a sincere way out near the end, for example "If this is not useful, tell me and I will stop."' })
  return issues
}

/** Every way a draft breaks the voice. An empty list is a pass. */
export function checkDraft(draft: DraftText, context: DraftContext = {}): VoiceIssue[] {
  const all = `${draft.subject}\n${draft.body}`
  const issues: VoiceIssue[] = [
    ...lengthIssues(draft),
    ...subjectIssues(draft.subject),
    ...phraseIssues(all),
    ...linkIssues(all),
    ...greetingIssue(draft.body, context.firstName),
    ...honestyIssues(all, draft.body),
  ]
  if (DASHES.test(all)) issues.push({ rule: 'em_dash', detail: 'Uses a dash as punctuation. Use a comma or a period.' })
  if (draft.body.includes('!')) issues.push({ rule: 'exclamation', detail: 'The body has an exclamation mark.' })
  if (EMOJI.test(all)) issues.push({ rule: 'emoji', detail: 'Uses an emoji.' })
  if (PRICE.test(all)) issues.push({ rule: 'pricing', detail: 'Quotes a price. Drafts never state pricing.' })
  if (PLACEHOLDER.test(all)) issues.push({ rule: 'placeholder', detail: 'Contains a placeholder that was never filled in.' })
  if (hasSignoffLine(draft.body)) issues.push({ rule: 'signature', detail: 'Ends with a sign-off line. The sender adds their own.' })
  return issues
}

/** The issues as one line per problem, for telling a model what to fix. */
export function describeIssues(issues: readonly VoiceIssue[]): string[] {
  return issues.map((i) => i.detail)
}
