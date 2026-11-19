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

export const VOICE_GUIDE_VERSION = 'draft-1'

/** What the guide has and has not been through. Shown on the dashboard, so nobody mistakes it for approved. */
export const VOICE_GUIDE_STATUS = 'Draft. Derived from the homepage copy; not yet reviewed by the founder.'

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

/** Advice to the drafting model. Not enforced: see checkDraft() for what is. */
export const VOICE_GUIDE: readonly string[] = [
  'Write the way one working operator writes to another. Plain, specific and short.',
  'Lead with something true and concrete about their business (their market, the size of their portfolio, the system they use), only if it was given to you. Never invent a detail about them.',
  'One idea per email. Say what the problem is in their terms (turnovers, crew, vendors, owner reports), then one sentence on how FieldStay takes it off their plate.',
  'Short sentences. No jargon, no hype, no exclamation marks, no emoji.',
  'Sound like a person with a calm view of the work, not a marketer. Never pressure. Never imply urgency that does not exist.',
  'End with one low-effort question or an offer to show them, and stop.',
  'Do not sign off with a name or a signature. The sender adds their own.',
]

// ── checks ──────────────────────────────────────────────────────────────────

export type VoiceRule =
  | 'em_dash' | 'subject_length' | 'subject_style' | 'body_length' | 'banned_phrase' | 'pricing'
  | 'link' | 'placeholder' | 'greeting' | 'exclamation' | 'signature' | 'emoji'

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

const DASHES = /[—–]| -- /
const EMOJI = /\p{Extended_Pictographic}/u
const PRICE = /\$\s?\d|\b\d[\d,.]*\s?(?:dollars|usd)\b/i
const URL_LIKE = /\bhttps?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+/gi
const PLACEHOLDER = /\[[^\]\n]{1,40}\]|\{\{[^}]*\}\}|<[a-z][a-z _-]{1,30}>|\bTODO\b|\bXXX\b/i
const SIGNOFF_LINE = /^\s*(?:best|best regards|regards|kind regards|sincerely|cheers|thanks|thank you|warmly)[,.!]?\s*$/im
const FAKE_THREAD = /^\s*(?:re|fwd?)\s*:/i

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

/** Every way a draft breaks the voice. An empty list is a pass. */
export function checkDraft(draft: DraftText, context: DraftContext = {}): VoiceIssue[] {
  const all = `${draft.subject}\n${draft.body}`
  const issues: VoiceIssue[] = [
    ...lengthIssues(draft),
    ...subjectIssues(draft.subject),
    ...phraseIssues(all),
    ...linkIssues(all),
    ...greetingIssue(draft.body, context.firstName),
  ]
  if (DASHES.test(all)) issues.push({ rule: 'em_dash', detail: 'Uses a dash as punctuation. Use a comma or a period.' })
  if (draft.body.includes('!')) issues.push({ rule: 'exclamation', detail: 'The body has an exclamation mark.' })
  if (EMOJI.test(all)) issues.push({ rule: 'emoji', detail: 'Uses an emoji.' })
  if (PRICE.test(all)) issues.push({ rule: 'pricing', detail: 'Quotes a price. Drafts never state pricing.' })
  if (PLACEHOLDER.test(all)) issues.push({ rule: 'placeholder', detail: 'Contains a placeholder that was never filled in.' })
  if (SIGNOFF_LINE.test(draft.body)) issues.push({ rule: 'signature', detail: 'Ends with a sign-off line. The sender adds their own.' })
  return issues
}

/** The issues as one line per problem, for telling a model what to fix. */
export function describeIssues(issues: readonly VoiceIssue[]): string[] {
  return issues.map((i) => i.detail)
}
