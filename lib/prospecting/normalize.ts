/**
 * Field normalizers for the prospecting funnel.
 *
 * A LEAF module: no imports, no Supabase, no server-only code. Three callers
 * share it and they run in three different places — the admin import wizard
 * (browser), scripts/import-prospects.ts (node), and the guardrail tests — so
 * anything that pulls in a client or `server-only` here would break one of
 * them.
 *
 * ── WHY THESE EXIST ─────────────────────────────────────────────────────────
 *
 * The live table had 142 distinct `pms` values for roughly thirty real
 * products, because the crawler records its fingerprint inline:
 *
 *     Streamline                                    108 rows
 *     Streamline (ownerx.streamlinevrs.com)          13
 *     Streamline (owner.streamlinevrs.com)            7
 *     Streamline (streamlinevrs.com)                  3
 *
 * Every one of those is Streamline, and the admin page's PMS facet listed
 * them as four separate options — so filtering to "Streamline" quietly
 * returned 108 of 133 companies and the other 25 looked like they ran
 * something else. The fingerprint is worth keeping; `pms_note` is where the
 * schema already says it goes ("How the PMS was determined"). So the split is
 * the fix, not deletion.
 */

/** Strips zero-width characters and collapses runs of whitespace. */
export function cleanText(value: string): string {
  return value.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim()
}

// ── state ────────────────────────────────────────────────────────────────────

const STATE_CODES: ReadonlyMap<string, string> = new Map([
  ['alabama', 'AL'], ['alaska', 'AK'], ['arizona', 'AZ'], ['arkansas', 'AR'],
  ['california', 'CA'], ['colorado', 'CO'], ['connecticut', 'CT'], ['delaware', 'DE'],
  ['district of columbia', 'DC'], ['washington dc', 'DC'], ['florida', 'FL'],
  ['georgia', 'GA'], ['hawaii', 'HI'], ['idaho', 'ID'], ['illinois', 'IL'],
  ['indiana', 'IN'], ['iowa', 'IA'], ['kansas', 'KS'], ['kentucky', 'KY'],
  ['louisiana', 'LA'], ['maine', 'ME'], ['maryland', 'MD'], ['massachusetts', 'MA'],
  ['michigan', 'MI'], ['minnesota', 'MN'], ['mississippi', 'MS'], ['missouri', 'MO'],
  ['montana', 'MT'], ['nebraska', 'NE'], ['nevada', 'NV'], ['new hampshire', 'NH'],
  ['new jersey', 'NJ'], ['new mexico', 'NM'], ['new york', 'NY'],
  ['north carolina', 'NC'], ['north dakota', 'ND'], ['ohio', 'OH'], ['oklahoma', 'OK'],
  ['oregon', 'OR'], ['pennsylvania', 'PA'], ['rhode island', 'RI'],
  ['south carolina', 'SC'], ['south dakota', 'SD'], ['tennessee', 'TN'],
  ['texas', 'TX'], ['utah', 'UT'], ['vermont', 'VT'], ['virginia', 'VA'],
  ['washington', 'WA'], ['west virginia', 'WV'], ['wisconsin', 'WI'],
  ['wyoming', 'WY'], ['puerto rico', 'PR'], ['us virgin islands', 'VI'],
])

const VALID_STATE_CODES: ReadonlySet<string> = new Set(STATE_CODES.values())

/**
 * A two-letter code, or null.
 *
 * Null rather than a guess for anything unrecognised: `properties.state` in
 * the tenant schema is free text precisely because guessing got it wrong, and
 * an abbreviation like "Tenn." is genuinely ambiguous to expand — it is not
 * worth inventing a state for a row whose own source was unsure.
 */
export function normalizeState(value: string): string | null {
  const cleaned = cleanText(value).replace(/\./g, '')
  if (cleaned === '') return null
  const upper = cleaned.toUpperCase()
  if (VALID_STATE_CODES.has(upper)) return upper
  return STATE_CODES.get(cleaned.toLowerCase()) ?? null
}

// ── contact ──────────────────────────────────────────────────────────────────

// Each domain label excludes the dot that separates it from the next, so
// there is exactly ONE way to split a host and the engine never has to try
// another. The obvious /^[^@\s]+@[^@\s]+\.[^@\s]+$/ lets the last two parts
// both match a dot, which means a 254-character address with no final dot is
// re-split at every position before it fails.
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/

export function normalizeEmail(value: string): string | null {
  const v = cleanText(value).replace(/^mailto:/i, '').toLowerCase()
  return v.length > 0 && v.length <= 254 && EMAIL_RE.test(v) ? v : null
}

/**
 * Splits a phone cell into an E.164 number and the text it came from.
 *
 * `raw` is kept even when the number cannot be parsed: "555-0142" and
 * "call the office, ask for Dana" are both things a human can act on, and
 * discarding them because they are not dialable by machine throws away the
 * only contact detail some of these rows have.
 */
export function normalizePhone(value: string): { e164: string | null; raw: string | null } {
  const raw = cleanText(value)
  if (raw === '') return { e164: null, raw: null }

  const capped = raw.slice(0, 60)
  // `\s?` rather than `\s*`, and no trailing `\s*$`: cleanText has already
  // trimmed and collapsed runs, so the unbounded forms could only ever have
  // re-tried the same single space at every position in the string. `ext` and
  // `extension` are one branch for the same reason — as separate alternatives
  // the engine matches `ext`, fails, and backtracks into the longer one.
  const withoutExt = raw.split(/\s?(?:ext(?:ension)?\.?|x)\s?\d+$/i)[0] ?? raw
  const digits = withoutExt.replace(/\D/g, '')

  // NANP: a real area code and exchange never start with 0 or 1.
  if (digits.length === 10 && /^[2-9]/.test(digits)) return { e164: `+1${digits}`, raw: capped }
  if (digits.length === 11 && digits.startsWith('1') && /^[2-9]/.test(digits.slice(1))) {
    return { e164: `+${digits}`, raw: capped }
  }
  return { e164: null, raw: capped }
}

// ── web ──────────────────────────────────────────────────────────────────────

/** Strips scheme, www and any path so the unique index sees one spelling. */
export function normalizeDomain(value: string | null): string | null {
  if (value === null) return null
  const d = cleanText(value)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .trim()
    .toLowerCase()
  return d === '' || !d.includes('.') ? null : d
}

/** A `scheme:` prefix, but not a `host:port` — a port is all digits. */
const FOREIGN_SCHEME_RE = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i

/**
 * An absolute http(s) URL, or null.
 *
 * The scheme check is not cosmetic: this value is rendered as a link on the
 * admin page, and `javascript:` in an href is script execution. Rejecting
 * anything that does not parse to http/https is what makes the link safe to
 * render without a second guard at every call site.
 *
 * A foreign scheme is rejected BEFORE the `https://` prefix is added, because
 * gluing one on does not fail — it reinterprets. `mailto:jane@example.com`
 * becomes `https://mailto:jane@example.com`, which is a perfectly valid URL
 * whose userinfo is `mailto:jane` and whose host is `example.com`, so the
 * protocol check downstream passes and an email address is silently stored as
 * that company's website. Userinfo is refused for the same reason: nothing
 * legitimate in this column carries credentials, and `https://evil.com@
 * real.com` reads as `real.com` to a person and resolves to `evil.com`.
 */
export function normalizeWebsite(value: string): string | null {
  const cleaned = cleanText(value)
  if (cleaned === '') return null

  const hasHttpScheme = /^https?:\/\//i.test(cleaned)
  if (!hasHttpScheme && FOREIGN_SCHEME_RE.test(cleaned)) return null

  try {
    const u = new URL(hasHttpScheme ? cleaned : `https://${cleaned}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username !== '' || u.password !== '') return null
    if (!u.hostname.includes('.')) return null
    const path = u.pathname === '/' ? '' : u.pathname
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}`.slice(0, 300)
  } catch {
    return null
  }
}

// ── size ─────────────────────────────────────────────────────────────────────

const MAX_PORTFOLIO = 100_000

/**
 * A door count from a cell that is half numbers and half prose.
 *
 * A range is read as its midpoint ("40-50" → 45) because that is what the
 * range means; "~45" and "50+" read as their stated number. Anything with no
 * leading digits stays null — the sheet's "est. 150+" and "Part of a national
 * network managing $16B+ in assets" both contain a number whose meaning an
 * integer column cannot carry, and the full text survives in
 * portfolio_size_method either way.
 */
export function parsePortfolio(value: string): number | null {
  const s = cleanText(value).replace(/,/g, '')
  if (s === '') return null

  const range = /^[~≈]?\s*(\d+)\s*(?:-|–|—|to)\s*(\d+)/i.exec(s)
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const n = Math.round((a + b) / 2)
      return n <= MAX_PORTFOLIO ? n : null
    }
  }

  // Leading digits only, after an optional tilde. "6 private cabins" is 6.
  // A prose prefix is refused on purpose: "est. 150+" contains a real number
  // whose meaning ("at least") an integer column cannot carry, and the full
  // text survives in portfolio_size_method either way.
  const single = /^[~≈]?\s*(\d+)/.exec(s)
  if (!single) return null
  const n = Number(single[1])
  return Number.isFinite(n) && n <= MAX_PORTFOLIO ? n : null
}

// ── PMS ──────────────────────────────────────────────────────────────────────

/**
 * Canonical spellings, longest/most-specific patterns first.
 *
 * Order matters where one product's name contains another's: `/track/` would
 * match "Racetrack Rentals", so it is anchored, and Wander OS is listed before
 * the bare Wander.
 */
const PMS_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/owner\s*rez/i,            'OwnerRez'],
  [/owner\s*networks/i,       'OwnerNetworks'],
  [/hospitable|smartbnb/i,    'Hospitable'],
  [/hostaway/i,               'Hostaway'],
  [/hostex/i,                 'Hostex'],
  [/hostfully/i,              'Hostfully'],
  [/guesty/i,                 'Guesty'],
  [/streamline/i,             'Streamline'],
  [/lodgify/i,                'Lodgify'],
  [/bright\s*side/i,          'BrightSide'],
  [/(?:^track(?:\s*hs)?\b)|trackhs/i, 'Track'],
  [/escapia/i,                'Escapia'],
  [/barefoot/i,               'Barefoot'],
  [/live\s*rez/i,             'LiveRez'],
  [/uplisting/i,              'Uplisting'],
  [/avantio/i,                'Avantio'],
  [/ciirus/i,                 'CiiRUS'],
  [/rentals\s*united/i,       'Rentals United'],
  [/rent\s*vine/i,            'Rentvine'],
  [/app\s*folio/i,            'AppFolio'],
  [/res\s*nexus/i,            'ResNexus'],
  [/rez\s*stream/i,           'RezStream'],
  [/think\s*reservations/i,   'ThinkReservations'],
  [/cloudbeds/i,              'Cloudbeds'],
  [/rezfusion|bluetent/i,     'Rezfusion/Bluetent'],
  [/holiday\s*future/i,       'HolidayFuture'],
  [/direct\s*stays/i,         'DirectStays'],
  [/wander(\s*os)?\b/i,       'Wander'],
  [/property\s*ware/i,        'Propertyware'],
  [/rent\s*manager/i,         'RentManager'],
  [/buildium|managebuilding/i, 'Buildium'],
  [/door\s*loop/i,            'DoorLoop'],
  [/red\s*awning/i,           'RedAwning'],
  [/home\s*runner/i,          'HomeRunner'],
  [/co\s*host\s*iq/i,         'CoHostIQ'],
  [/yardi|rent\s*cafe/i,      'Yardi'],
  [/vacation\s*rental\s*desk/i, 'Vacation Rental Desk'],
  [/^beyond\b/i,              'Beyond'],
  [/\bvrm\b/i,                'VRM'],
  [/\brns\b/i,                'RNS'],
  [/\brms\b/i,                'RMS'],
  [/\bv12\b/i,                'V12'],
]

export interface PmsParts {
  /** The canonical product name, or null when the cell held no product. */
  pms: string | null
  /** The fingerprint, hostname or observation the cell also carried. */
  evidence: string | null
}

/**
 * True when a PMS cell holds an actual product name rather than prose.
 *
 * Two things land in that column and neither is a PMS: a spilled fragment
 * from an unquoted comma in the size column (" not local count)"), and a
 * researcher's observation typed in by hand ("website directs to AirBnB").
 * Both are worth KEEPING — they are evidence — but under pms_note. A real
 * product name starts with a capital letter or a digit; neither of those
 * shapes does.
 */
function looksLikePmsName(value: string): boolean {
  return /^[A-Z0-9]/.test(value)
}

/**
 * Splits a raw `pms` cell into the product and the evidence for it.
 *
 * The evidence is everything the cell carried beyond the name — a
 * parenthetical hostname, a trailing "; Rezfusion front end", a "(seen)".
 * It goes to `pms_note`, whose documented job is exactly that, so the facet
 * dropdown collapses to real products without losing how each was determined.
 */
export function normalizePms(value: string): PmsParts {
  const cleaned = cleanText(value)
  if (cleaned === '') return { pms: null, evidence: null }

  // Pull out every parenthetical, then whatever follows a ';' or '/' separator
  // that is not part of a known product name.
  const parentheticals: string[] = []
  const withoutParens = cleaned
    // `[^()]*` excludes the OPENING paren too. With `[^)]*`, a cell of
    // unclosed parens makes the engine consume to the end from every `(` and
    // give the characters back one at a time — quadratic on a value that is
    // never going to match anyway.
    .replace(/\(([^()]*)\)/g, (_m, inner: string) => {
      const t = inner.trim()
      if (t !== '') parentheticals.push(t)
      return ' '
    })
    .trim()

  const [headRaw = '', ...tailParts] = withoutParens.split(';')
  const head = cleanText(headRaw)
  const tail = tailParts.map((t) => cleanText(t)).filter((t) => t !== '')

  // Every brand the head names, not just the first. "AppFolio / Guesty (both
  // seen)" is one cell recording two systems, and keeping only the first
  // would assert something the source did not say.
  const matched = PMS_ALIASES.filter(([re]) => re.test(head)).map(([, name]) => name)
  const [canonical = null, ...alsoSeen] = matched

  // Nothing recognisable and not even shaped like a product name: the whole
  // cell is an observation. Keep it, under the label that describes it.
  if (canonical === null && !looksLikePmsName(head)) {
    return { pms: null, evidence: cleaned }
  }

  const evidenceParts = [
    ...alsoSeen.map((name) => `also ${name}`),
    ...parentheticals,
    ...tail,
  ]
  // An unrecognised but plausible product name (a PMS we have not catalogued)
  // is kept verbatim rather than discarded — the list grows from the field.
  const pms = canonical ?? (head === '' ? null : head.slice(0, 80))

  return {
    pms,
    evidence: evidenceParts.length > 0 ? evidenceParts.join('; ') : null,
  }
}

// ── identity ─────────────────────────────────────────────────────────────────

/**
 * Company name reduced to what identifies it.
 *
 * Case, punctuation and a trailing legal suffix are noise between two
 * spellings of one company — 372 live rows carry an LLC/Inc/Co suffix, 117 an
 * ampersand, 57 a leading "The" — and an incoming sheet does not spell them
 * the way the database does.
 */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(llc|l\.l\.c|inc|incorporated|co|corp|corporation|ltd|limited)\b/g, ' ')
    .replace(/^\s*the\s+/, ' ')
    .replace(/[^a-z0-9]+/g, '')
}

/** Lowercased and stripped of punctuation; '' for absent, so it still keys. */
export function normalizeText(raw: string | null): string {
  return (raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}
