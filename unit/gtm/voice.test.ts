import { describe, it, expect } from 'vitest'
import {
  BANNED_PHRASES, FALSE_FAMILIARITY, MAX_BODY_WORDS, MAX_SUBJECT_CHARS, MIN_BODY_WORDS, PRESSURE, PRESUMED_PROBLEM, PRODUCT_FACTS, SENDER_FACTS, SENDER_OVERCLAIM, SOCIAL_PROOF, VOICE_GUIDE,
  VOICE_GUIDE_STATUS, checkDraft, describeIssues, type DraftText, type VoiceRule,
} from '@/lib/gtm/brand/voice'

const GOOD_BODY = 'Hi Dana, running thirty cabins on Lake Martin means a lot of Friday turnovers. FieldStay creates each turnover from the booking, suggests who should take it, and lets the crew work from a phone checklist even with no signal. Setting up a property takes about 15 minutes. Would it help if I showed you how it works on one of your cabins? If this is not useful, tell me and I will stop.'
const GOOD: DraftText = { subject: 'Turnovers on Lake Martin', body: GOOD_BODY }
const rules = (d: DraftText, first: string | null = 'Dana'): VoiceRule[] => checkDraft(d, { firstName: first }).map((i) => i.rule)
const withBody = (body: string): DraftText => ({ ...GOOD, body })

describe('checkDraft: a good draft', () => {
  it('passes', () => {
    expect(checkDraft(GOOD, { firstName: 'Dana' })).toEqual([])
  })

  it('stays within its own length limits', () => {
    expect(GOOD_BODY.split(/\s+/).length).toBeGreaterThanOrEqual(MIN_BODY_WORDS)
    expect(GOOD_BODY.split(/\s+/).length).toBeLessThanOrEqual(MAX_BODY_WORDS)
  })
})

describe('checkDraft: the rules', () => {
  // The house rule. The em dash is the one most likely to arrive uninvited from a model.
  it.each(['—', '–', ' -- '])('refuses a dash used as punctuation (%j)', (dash) => {
    expect(rules(withBody(GOOD_BODY.replace('Hi Dana, running', `Hi Dana, running${dash}`)))).toContain('em_dash')
    expect(rules({ ...GOOD, subject: `Turnovers${dash}Lake Martin` })).toContain('em_dash')
  })

  it('allows an ordinary hyphen', () => {
    expect(rules(withBody(GOOD_BODY.replace('thirty cabins', 'thirty well-run cabins')))).toEqual([])
  })

  it('enforces the subject length, empty and over', () => {
    expect(rules({ ...GOOD, subject: '' })).toContain('subject_length')
    expect(rules({ ...GOOD, subject: 'x'.repeat(MAX_SUBJECT_CHARS + 1) })).toContain('subject_length')
    expect(rules({ ...GOOD, subject: 'x'.repeat(MAX_SUBJECT_CHARS) })).not.toContain('subject_length')
  })

  it('enforces the body length, short and long', () => {
    expect(rules(withBody('Hi Dana, hello there.'))).toContain('body_length')
    expect(rules(withBody(`Hi Dana, ${'word '.repeat(MAX_BODY_WORDS)}`))).toContain('body_length')
  })

  it.each([
    ['an exclamation in the subject', { ...GOOD, subject: 'Turnovers!' }],
    ['a shouted word', { ...GOOD, subject: 'FREE turnovers' }],
    ['a fake reply', { ...GOOD, subject: 'Re: our call' }],
    ['a fake forward', { ...GOOD, subject: 'Fwd: intro' }],
  ])('refuses %s', (_label, draft) => {
    expect(rules(draft)).toContain('subject_style')
  })

  it.each(BANNED_PHRASES.slice(0, 40))('refuses the phrase %j wherever it appears', (phrase) => {
    expect(rules(withBody(GOOD_BODY.replace('Setting up', `${phrase}. Setting up`)))).toContain('banned_phrase')
    expect(rules({ ...GOOD, subject: `About ${phrase}`.slice(0, 55) })).toContain('banned_phrase')
  })

  it('matches phrases regardless of case', () => {
    expect(rules(withBody(GOOD_BODY.replace('Setting up', 'JUST CHECKING IN. Setting up')))).toContain('banned_phrase')
  })

  it.each(['It starts at $19 a month.', 'Plans are 49 dollars.', 'It is 20 USD.', 'About $1,200 a year.'])('never states a price: %s', (line) => {
    expect(rules(withBody(`${GOOD_BODY} ${line}`))).toContain('pricing')
  })

  it('allows a dollar sign that is not a price', () => {
    expect(rules(withBody(GOOD_BODY.replace('thirty cabins', 'thirty cabins, none of them cheap')))).not.toContain('pricing')
  })

  it('allows a link to fieldstay.app and refuses any other', () => {
    expect(rules(withBody(`${GOOD_BODY} See https://fieldstay.app/strops.`))).not.toContain('link')
    expect(rules(withBody(`${GOOD_BODY} See https://app.fieldstay.app/demo.`))).not.toContain('link')
    expect(rules(withBody(`${GOOD_BODY} See https://competitor.example/x.`))).toContain('link')
    expect(rules(withBody(`${GOOD_BODY} See www.example.com.`))).toContain('link')
  })

  // A lookalike must not pass for the real host.
  it('does not treat a lookalike domain as fieldstay.app', () => {
    expect(rules(withBody(`${GOOD_BODY} See https://fieldstay.app.evil.example/x.`))).toContain('link')
    expect(rules(withBody(`${GOOD_BODY} See https://notfieldstay.app/x.`))).toContain('link')
  })

  it.each(['[First Name]', '{{company}}', '<name>', 'TODO fix this', 'XXX'])('refuses an unfilled placeholder: %s', (ph) => {
    expect(rules(withBody(`${GOOD_BODY} ${ph}`))).toContain('placeholder')
  })

  it('refuses an exclamation mark in the body, and an emoji anywhere', () => {
    expect(rules(withBody(`${GOOD_BODY} Great!`))).toContain('exclamation')
    expect(rules(withBody(`${GOOD_BODY} \u{1F600}`))).toContain('emoji')
    expect(rules({ ...GOOD, subject: 'Turnovers \u{1F3E0}' })).toContain('emoji')
  })

  it.each(['Best,', 'Best regards,', 'Sincerely,', 'Cheers', 'Thanks,', 'Thank you.'])('refuses a closing line of %j, since the sender adds their own', (line) => {
    expect(rules(withBody(`${GOOD_BODY}\n\n${line}`))).toContain('signature')
  })

  it('does not mistake the word "thanks" inside a sentence for a sign-off', () => {
    expect(rules(withBody(GOOD_BODY.replace('Would it help', 'Thanks to the app, would it help')))).not.toContain('signature')
  })
})

describe('checkDraft: the greeting', () => {
  it('requires the first name when it is known', () => {
    expect(rules(withBody(GOOD_BODY.replace('Hi Dana,', 'Hello Dana,')))).toContain('greeting')
    expect(rules(withBody(GOOD_BODY.replace('Hi Dana,', 'Hi Sam,')))).toContain('greeting')
    expect(rules(GOOD)).not.toContain('greeting')
  })

  it('matches the name regardless of case', () => {
    expect(checkDraft(withBody(GOOD_BODY.replace('Hi Dana,', 'hi dana,')), { firstName: 'Dana' })).toEqual([])
  })

  // An invented name is worse than none.
  it('requires "Hi there," when no name is known, and refuses an invented name', () => {
    expect(checkDraft(withBody(GOOD_BODY.replace('Hi Dana,', 'Hi there,')), { firstName: null })).toEqual([])
    expect(rules(GOOD, null)).toContain('greeting')
  })

  it('treats a blank name as no name', () => {
    expect(rules(withBody(GOOD_BODY.replace('Hi Dana,', 'Hi there,')), '  ')).toEqual([])
  })
})

describe('checkDraft: reporting', () => {
  it('reports every problem at once, so a model can fix them in one pass', () => {
    const bad = { subject: 'Re: FREE!', body: 'Hello. Act now! It is $19.' }
    const found = new Set(rules(bad))
    for (const r of ['subject_style', 'body_length', 'banned_phrase', 'pricing', 'exclamation', 'greeting'] as VoiceRule[]) expect(found.has(r)).toBe(true)
  })

  it('describes each issue in a sentence', () => {
    const lines = describeIssues(checkDraft({ subject: '', body: 'x' }))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.endsWith('.') || l.endsWith('"'))).toBe(true)
  })
})

describe('the voice guide itself', () => {
  it('says it is a draft until someone approves it', () => {
    expect(VOICE_GUIDE_STATUS).toMatch(/draft/i)
    expect(VOICE_GUIDE_STATUS).toMatch(/not yet reviewed/i)
  })

  it('is itself written in the voice: no dash as punctuation, no exclamation', () => {
    for (const line of [...VOICE_GUIDE, ...PRODUCT_FACTS]) {
      expect(line).not.toMatch(/[—–!]/)
    }
  })

  // The product facts are the only claims a draft may make. None may be a price or a superlative.
  it('states no price and no superlative in the product facts', () => {
    for (const fact of PRODUCT_FACTS) {
      expect(checkDraft({ subject: 'x', body: fact }).filter((i) => i.rule === 'pricing' || i.rule === 'banned_phrase')).toEqual([])
    }
  })
})

// The honesty rules. Every list is a way of saying something we cannot stand behind,
// and a hit is a failed draft, so each one is pinned individually.
describe('checkDraft: honesty', () => {
  const swap = (phrase: string) => withBody(GOOD_BODY.replace('Setting up', `${phrase}. Setting up`))

  it.each([
    ['false_familiarity', FALSE_FAMILIARITY],
    ['sender_overclaim', SENDER_OVERCLAIM],
    ['pressure', PRESSURE],
    ['presumed_problem', PRESUMED_PROBLEM],
    ['social_proof', SOCIAL_PROOF],
  ] as const)('refuses every %s phrase, in any case', (rule, list) => {
    for (const phrase of list) {
      expect(rules(swap(phrase)), phrase).toContain(rule)
      expect(rules(swap(phrase.toUpperCase())), phrase).toContain(rule)
    }
  })

  it.each([
    'Setting up takes 15% of the time',
    'It will save you hours every week',
    'FieldStay cuts turnover time by 30 minutes',
  ])('refuses an unmeasured claim: %s', (claim) => {
    expect(rules(withBody(GOOD_BODY.replace('Setting up a property takes about 15 minutes', claim)))).toContain('unbacked_claim')
  })

  it('allows the one number the product facts carry', () => {
    expect(rules(GOOD)).not.toContain('unbacked_claim')
  })

  it('requires a sincere way out', () => {
    const noExit = withBody(GOOD_BODY.replace(' If this is not useful, tell me and I will stop.', ''))
    expect(rules(noExit)).toContain('opt_out')
  })

  it.each([
    'If this is not relevant, say so and I will stop.',
    'Let me know if this is not a fit and I will not write again.',
    'If you are not interested, just say so and I won\'t follow up.',
  ])('accepts the way out written as: %s', (line) => {
    const body = GOOD_BODY.replace('If this is not useful, tell me and I will stop.', line)
    expect(rules(withBody(body))).not.toContain('opt_out')
  })

  it('ignores a way out that is only in the subject', () => {
    const noExit = { subject: 'Tell me and I will stop', body: GOOD_BODY.replace(' If this is not useful, tell me and I will stop.', '') }
    expect(rules(noExit)).toContain('opt_out')
  })

  it('lets the sender say they have done turnovers, and nothing more', () => {
    expect(rules(swap('I have done turnovers myself'))).toEqual([])
    expect(rules(swap('I\'ve done turnovers myself, so I know the Friday scramble'))).toEqual([])
    for (const claim of ['I managed twelve cabins', 'After years of experience in this', 'I\'ve been there', 'As a property manager myself']) {
      expect(rules(swap(claim)), claim).toContain('sender_overclaim')
    }
    expect(SENDER_FACTS.join(' ')).toMatch(/done turnovers/)
  })

  it('carries the honesty directive first in the guidance a model reads', () => {
    expect(VOICE_GUIDE[0]).toMatch(/genuine and honest/i)
  })

  it('does not trip on the product facts themselves', () => {
    for (const fact of PRODUCT_FACTS) {
      const hits = checkDraft({ subject: 'x', body: `Hi there, ${fact}` }).map((i) => i.rule)
      expect(hits, fact).not.toContain('unbacked_claim')
      expect(hits, fact).not.toContain('social_proof')
      expect(hits, fact).not.toContain('false_familiarity')
    }
  })
})

// A draft is a model's output, which is untrusted text. These patterns were quadratic or
// super-linear before, so each is held to a time budget on its worst input.
describe('checkDraft: hostile input stays fast', () => {
  const timed = (body: string): number => {
    const start = performance.now()
    checkDraft({ subject: 'x', body: `Hi there, ${body}` })
    return performance.now() - start
  }

  it.each([
    ['an unclosed placeholder brace, repeated', '{{'.repeat(40_000)],
    ['thousands of blank lines', '\n \t \n'.repeat(40_000)],
    ['a long run of save words', 'save '.repeat(40_000)],
    ['a long run of cut words', 'cuts by '.repeat(40_000)],
    ['an unclosed bracket, repeated', '['.repeat(40_000)],
    ['a very long digit run with no percent sign', '1'.repeat(80_000)],
  ])('handles %s without a stall', (_label, body) => {
    expect(timed(body)).toBeLessThan(1_500)
  })

  it('still sees a sign-off line, a placeholder and a saving after the rewrite', () => {
    for (const closer of ['Best', 'Kind regards,', 'cheers!', '  Thank you  ']) {
      expect(rules(withBody(`${GOOD_BODY}\n\n${closer}`)), closer).toContain('signature')
    }
    expect(rules(withBody(GOOD_BODY.replace('Dana', '{{first_name}}')))).toContain('placeholder')
    expect(rules(withBody(`${GOOD_BODY} It saves a few hours of time.`))).toContain('unbacked_claim')
    expect(rules(withBody(`${GOOD_BODY} That cuts the work by 40 minutes.`))).toContain('unbacked_claim')
  })

  it.each(['15%', '2.5%', '40 %', 'by 100%'])('still sees a percentage: %s', (pct) => {
    expect(rules(withBody(`${GOOD_BODY} It is ${pct} better.`))).toContain('unbacked_claim')
  })

  it('does not call an ordinary closing line a sign-off', () => {
    expect(rules(withBody(`${GOOD_BODY} Thanks for reading this far.`))).not.toContain('signature')
  })
})
