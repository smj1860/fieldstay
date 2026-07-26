import type { GeneratedResponse } from '@/lib/repuguard/generate-response'

/**
 * Canned RepuGuard sandbox for the roadshow booth.
 *
 * DELIBERATELY NOT A LIVE MODEL CALL. The sandbox replays pre-written
 * responses with a streaming reveal so it looks exactly like generation
 * happening on the spot. That buys three things a live call cannot:
 *
 *   - No Anthropic spend, and no rate limiter needed to bound an unattended
 *     tablet at the booth.
 *   - No network dependency once the page has loaded — the single most
 *     dramatic moment of the demo cannot be killed by convention wifi.
 *   - Deterministic output. A live model picks its own words each time; here
 *     the exact copy shown to the OwnerRez team is reviewed in advance, and
 *     the safeguard cases below demonstrate reliably instead of hopefully.
 *
 * Each `response` is authored to satisfy the real REPUGUARD_SYSTEM_PROMPT's
 * rules (lib/repuguard/generate-response.ts), so nothing here misrepresents
 * what the shipping product does — see the per-scenario notes. The
 * defamation case in particular reproduces the prompt's mandated hold text
 * verbatim rather than an approximation of it.
 */

export interface SandboxReview {
  id:            string
  guestName:     string
  propertyName:  string
  starRating:    number
  reviewText:    string
  source:        'Airbnb' | 'VRBO' | 'Direct'
  /** Days before "today" the review landed — rendered as relative age. */
  daysAgo:       number
  /** Internal PM context the real flow feeds the model alongside the review. */
  internalNotes: string | null
  /** What the model returns. Shape matches GeneratedResponse exactly. */
  generated:     GeneratedResponse
  /**
   * Why this scenario is in the deck — shown as a caption so the person
   * being demoed to understands what they just watched.
   */
  demoNote:      string
}

const FIVE_STAR: SandboxReview = {
  id:           'sbx-5star',
  guestName:    'Marguerite Ollivander',
  propertyName: 'Sandpiper Cottage',
  starRating:   5,
  source:       'Airbnb',
  daysAgo:      2,
  reviewText:
    'Absolutely perfect week. The cottage was spotless when we walked in, the ' +
    'beach chairs and umbrella in the closet were a lovely surprise, and the ' +
    'check-in instructions were the clearest I have ever gotten from a rental. ' +
    'Maria even left a note about the best time to walk down to the pier. We ' +
    'have already asked about next June.',
  internalNotes: null,
  generated: {
    response:
      'Marguerite, thank you — this made our whole team smile. Maria takes real ' +
      'pride in how Sandpiper Cottage looks when guests walk in, and I will make ' +
      'sure she sees your note about the pier tip. The beach chairs and umbrella ' +
      'are there precisely because guests told us they wanted them, so it is ' +
      'wonderful to hear they landed. We would love to have you back next June — ' +
      'reach out any time and we will hold the week for you.',
    word_count:  81,
    tone_used:   'warm_appreciative',
    flags:       [],
    flag_reason: null,
  },
  demoNote:
    'The easy case. Note it names the specific cleaner and the specific detail ' +
    'from the review — generic gratitude reads as automated, and guests notice.',
}

const THREE_STAR_MIXED: SandboxReview = {
  id:           'sbx-3star',
  guestName:    'Desmond Fairbairn',
  propertyName: 'Pelican Perch 402',
  starRating:   3,
  source:       'VRBO',
  daysAgo:      5,
  reviewText:
    'The unit itself is great — good beds, great balcony view, well stocked ' +
    'kitchen. But the AC struggled the entire stay. It never got below about 78 ' +
    'during the day and we called twice. Someone did come out on day three and ' +
    'it improved a little. For what we paid I expected the AC to just work.',
  internalNotes:
    'Air handler serviced during the stay; capacitor replaced. Unit is 7 years ' +
    'old and undersized for the west exposure. Replacement quoted, scheduled.',
  generated: {
    response:
      'Desmond, thank you for being straight with us — and you are right. An AC ' +
      'that cannot hold temperature is not a small inconvenience on the Gulf ' +
      'coast in July, and "it improved a little" is not the standard we hold ' +
      'ourselves to. Our tech replaced the capacitor during your stay, which is ' +
      'why you saw partial improvement, but the underlying issue is that the ' +
      'existing unit is undersized for that exposure. A full replacement is ' +
      'already quoted and scheduled. I would genuinely like to make this right ' +
      'for you directly — please reach us at the number on your booking ' +
      'confirmation and ask for me.',
    word_count:  106,
    tone_used:   'accountable_corrective',
    flags:       [],
    flag_reason: null,
  },
  demoNote:
    'The one that sells it. The internal note — capacitor replaced, unit ' +
    'undersized, replacement scheduled — never appears in the review, but the ' +
    'reply uses it to explain the partial fix instead of vaguely apologizing.',
}

const ONE_STAR_ANGRY: SandboxReview = {
  id:           'sbx-1star',
  guestName:    'Corinne Vasquez-Hale',
  propertyName: 'Dune Ridge Retreat',
  starRating:   1,
  source:       'Airbnb',
  daysAgo:      1,
  reviewText:
    'Do not book this place. We arrived to a hot tub that was green and unusable ' +
    'and nobody warned us. That was the entire reason my kids wanted this house. ' +
    'Four days of a vacation ruined and the response we got was basically shrug.',
  internalNotes:
    'Hot tub failed chemical balance check the morning of arrival after a pump ' +
    'fault. Vendor drained/refilled, back in service day 3. Guest was not ' +
    'proactively notified — that is on us.',
  generated: {
    response:
      'Corinne, I am sorry. You should have been told before you drove down, and ' +
      'you were not — that is our failure, not a misunderstanding. A pump fault ' +
      'the morning of your arrival put the hot tub out of chemical balance; our ' +
      'vendor drained and refilled it and it was back in service on day three. ' +
      'None of that changes the fact that your kids lost the thing they were ' +
      'most looking forward to, and that you found out by walking up to it. ' +
      'Please contact us directly at the number on your confirmation so we can ' +
      'discuss making this right.',
    word_count:  101,
    tone_used:   'de_escalating_accountable',
    flags:       [],
    flag_reason: null,
  },
  demoNote:
    'Opens by conceding the actual failure — no "we are sorry you feel that ' +
    'way." Future guests read this reply far more often than they read the ' +
    'review it answers.',
}

const BILLING_DISPUTE: SandboxReview = {
  id:           'sbx-billing',
  guestName:    'Rutherford Pinkney',
  propertyName: 'Mariner Cove 11',
  starRating:   2,
  source:       'Direct',
  daysAgo:      3,
  reviewText:
    'The condo was fine but we were charged an extra $340 after checkout with no ' +
    'explanation and nobody will return my calls about it. I have disputed it ' +
    'with my credit card company.',
  internalNotes: 'Charge is the documented pet fee. Guest brought an undisclosed dog.',
  generated: {
    response:
      'Mr. Pinkney, thank you for raising this, and I am sorry you have not been ' +
      'able to reach anyone — that part is on us. Post-checkout charges should ' +
      'always come with a clear itemization, and I want to walk you through this ' +
      'one personally rather than in a public thread. Please contact us at the ' +
      'number on your booking confirmation and ask for the property manager; we ' +
      'will review the charge with you line by line.',
    word_count:  76,
    tone_used:   'neutral_private_channel',
    flags:       ['billing'],
    flag_reason:
      'Guest reports an active credit-card chargeback on a disputed post-checkout ' +
      'charge. Held for PM review — do not state the reason for the charge ' +
      'publicly while a dispute is open.',
  },
  demoNote:
    'The safeguard. It does NOT auto-post, and it deliberately never says "the ' +
    'charge was for your undisclosed dog" in public while a chargeback is open.',
}

const LEGAL_THREAT: SandboxReview = {
  id:           'sbx-legal',
  guestName:    'Sylvia Trant',
  propertyName: 'Tideline Townhome 7B',
  starRating:   1,
  source:       'VRBO',
  daysAgo:      6,
  reviewText:
    'My daughter cut her foot badly on a broken deck board that was clearly ' +
    'rotted through. We spent the evening in urgent care. I have spoken to my ' +
    'lawyer and we will be pursuing this.',
  internalNotes: 'Incident reported. Deck board replaced same week. Insurer notified.',
  generated: {
    response:
      'Ms. Trant, I am very sorry about your daughter\'s injury, and I hope she is ' +
      'recovering well. We take this seriously: the board was replaced that week ' +
      'and the incident has been reported to our insurer. Because this involves ' +
      'a personal injury, I do not want to handle it through a public review ' +
      'thread — please contact us directly at the number on your booking ' +
      'confirmation so we can speak properly.',
    word_count:  71,
    tone_used:   'empathetic_restrained',
    flags:       ['legal'],
    flag_reason:
      'Guest states they have retained counsel and intend to pursue a personal ' +
      'injury claim. Held for PM and insurer review — no admission of liability ' +
      'and no discussion of the deck\'s prior condition should be posted publicly.',
  },
  demoNote:
    'Notice what is absent: no admission of fault, no mention of the board being ' +
    'rotted, even though the internal note confirms it was replaced. Held, not posted.',
}

const DEFAMATION_HOLD: SandboxReview = {
  id:           'sbx-defamation',
  guestName:    'Anonymous Guest',
  propertyName: 'Sea Oats Hideaway',
  starRating:   1,
  source:       'Airbnb',
  daysAgo:      1,
  reviewText:
    'There were hidden cameras in this house recording us. The owner is spying ' +
    'on guests and someone went through our bags while we were at the beach.',
  internalNotes: null,
  generated: {
    // Verbatim from REPUGUARD_SYSTEM_PROMPT — the prompt mandates this exact
    // string and nothing else for criminal/defamatory allegations. Do not
    // reword it: the point of this scenario is that the product refuses to
    // draft a public reply at all, and a paraphrase here would misrepresent
    // the shipping behavior.
    response:
      'This response has been held pending internal review. Please contact your ' +
      'FieldStay support team before posting any public reply.',
    word_count:  19,
    tone_used:   'withheld',
    flags:       ['legal', 'safety'],
    flag_reason:
      'Review alleges criminal conduct — covert recording of guests and theft ' +
      'from personal belongings. These are allegations that carry both ' +
      'defamation exposure and platform-safety implications. No public-facing ' +
      'response should be drafted or posted. Escalate to the owner, the ' +
      'platform, and counsel before any reply.',
  },
  demoNote:
    'The one worth pausing on. Asked to answer an accusation of criminal ' +
    'conduct, the correct product behavior is to refuse to draft a public ' +
    'reply — so it does, and says why.',
}

/** Ordered easy → hard: the deck builds toward the safeguard cases. */
export const SANDBOX_REVIEWS: readonly SandboxReview[] = [
  FIVE_STAR,
  THREE_STAR_MIXED,
  ONE_STAR_ANGRY,
  BILLING_DISPUTE,
  LEGAL_THREAT,
  DEFAMATION_HOLD,
]

// ── Streaming simulation ────────────────────────────────────────────────────

/**
 * How long the "thinking" pause runs before the first character appears, in
 * ms. A real claude-sonnet-5 call on this prompt lands around here, and the
 * pause is what makes the reveal read as generation rather than playback.
 */
export const THINKING_MS = 900

/** Milliseconds between reveal ticks. */
export const TICK_MS = 16

/**
 * Characters revealed per tick. At TICK_MS=16 this is roughly 190 chars/sec,
 * which is in the range of a fast streaming completion — quick enough not to
 * stall a booth conversation, slow enough to read along with.
 */
export const CHARS_PER_TICK = 3

/**
 * Length of the revealed prefix after `elapsedMs` of streaming.
 *
 * Pure and separately testable — the component only owns the timer. Returns
 * the full length once the reveal completes, so a caller can detect
 * completion by comparing against text.length rather than tracking its own
 * finished flag.
 */
export function revealedLength(elapsedMs: number, totalChars: number): number {
  if (elapsedMs <= 0) return 0
  const ticks = Math.floor(elapsedMs / TICK_MS)
  return Math.min(totalChars, ticks * CHARS_PER_TICK)
}

/** Total time the full reveal takes, for a progress affordance. */
export function totalRevealMs(totalChars: number): number {
  return Math.ceil(totalChars / CHARS_PER_TICK) * TICK_MS
}
