/**
 * Friction Forecaster, Module 1 — the pre-flight scoring library.
 *
 * Pure, deterministic, dependency-free (beyond the DayForecast type). No LLM
 * call anywhere in this module and no external HTTP call of its own: the one
 * network read in the whole feature is the existing Tomorrow.io forecast
 * helper, which the cron calls and passes in here already resolved.
 *
 * ── The weight budget ──────────────────────────────────────────────────────
 * Every component contributes toward ONE 0.000-1.000 scale, read as an
 * estimated probability that the turnover will not go cleanly. That scale is
 * what `pre_flight_friction.failure_probability numeric(4,3)` stores and what
 * severityFromScore() thresholds against.
 *
 *   crewDurationVsBaseline  0.50   dominant — a real overrun ratio is the
 *                                  strongest single predictor
 *   weather                 0.15   hot + rainy can both apply (additive)
 *   weekend                 0.10   flat
 *   holiday                 0.15   flat
 *   seasonal                0.15   flat, per active window
 *   springBreak             0.10   region-keyed, profile-gated
 *   interaction             0.20   tiered, mutually exclusive — max tier only
 *   localEvents             0      reserved seam, see below
 *   ----------------------------------------------------------------------
 *   sum of maxes            1.35
 *
 * The maxes sum to 1.35, and that is the design rather than an oversight. The
 * interaction term represents compounding ON TOP OF each factor's own
 * contribution — holiday, weekend and season each still count their own base
 * weight while also triggering the bonus — and springBreak is an independent
 * driver of guest volume rather than a calendar coincidence with the other
 * three, so it adds on top the way weather does. computeFrictionScore clamps
 * to 1.0 instead of re-tuning every weight so they can never combine past it:
 * a genuinely worst-case day should read "100% — this will fail", not a
 * semantically broken number above 1.
 */

import { RAINY_PRECIP_PROBABILITY, type DayForecast } from '@/lib/weather/tomorrow'

// ── The composite ───────────────────────────────────────────────────────────

export interface FrictionComponents {
  crewDurationVsBaseline: number
  weather:                number
  weekend:                number
  holiday:                number
  seasonal:               number
  /** Region-keyed by property.state, gated to summer_lake/coastal_summer. */
  springBreak:            number
  /** Tiered: holiday x weekend x season > holiday x weekend > holiday x season > weekend x season. */
  interaction:            number
  /**
   * ALWAYS 0 today, and the key must never be dropped.
   *
   * It is the seam a future local-events scorer plugs into, and it is stored
   * in every score_breakdown so "no local-events signal" and "this row
   * predates the scorer" stay distinguishable. The mechanism, if it is ever
   * built, is a paid demand-intelligence API or a public schedule pull —
   * never PM-entered event data, which would put back exactly the upkeep this
   * whole feature exists to remove.
   */
  localEvents:            number
}

export function computeFrictionScore(c: FrictionComponents): number {
  const raw = Object.values(c).reduce((sum, v) => sum + v, 0)
  // See the weight-budget note above: the maxes sum to 1.35 by design, and
  // this clamp is what keeps the stored failure_probability semantically a
  // probability. It is load-bearing, not decorative.
  return Math.min(1, raw)
}

export function severityFromScore(score: number): 'none' | 'high' | 'critical' {
  if (score >= 0.85) return 'critical'
  if (score >= 0.55) return 'high'
  return 'none'
}

// ── Component: crew duration vs. baseline ───────────────────────────────────

const CREW_DURATION_MAX_SCORE = 0.50
/** 50% over the available window is maximal on this component. */
const CREW_DURATION_MAX_OVERRUN_RATIO = 0.5

/**
 * @param estimatedMinutesNeeded  assigned crew's baseline minutes-per-bedroom
 *                                x the property's bedroom count
 * @param availableWindowMinutes  checkin_datetime - checkout_datetime
 *
 * Linear from ratio 1.0 (the window is exactly consumed — score 0) to 1.5+
 * (score caps). The excess is clamped BEFORE scaling, so an absurd ratio
 * cannot spend more than this component's budget.
 */
export function crewDurationScore(
  estimatedMinutesNeeded: number,
  availableWindowMinutes: number,
): number {
  // No window at all — maximal, rather than a divide-by-zero NaN that would
  // propagate silently through the sum and store as a broken probability.
  if (availableWindowMinutes <= 0) return CREW_DURATION_MAX_SCORE
  if (estimatedMinutesNeeded <= 0) return 0

  const overrunRatio = estimatedMinutesNeeded / availableWindowMinutes
  if (overrunRatio <= 1.0) return 0

  const excess = Math.min(overrunRatio - 1.0, CREW_DURATION_MAX_OVERRUN_RATIO)
  return (excess / CREW_DURATION_MAX_OVERRUN_RATIO) * CREW_DURATION_MAX_SCORE
}

// ── Component: weather ──────────────────────────────────────────────────────
//
// Additive, not tiered: heat and rain are physically independent, unlike
// weekend/holiday/season, which are calendar facts about the same date and
// would double-count a shared signal if summed.

const WEATHER_HOT_WEIGHT   = 0.08
const WEATHER_RAINY_WEIGHT = 0.07

/**
 * Deliberately hotter than WeatherContext.isHot's 85F guest-comfort read.
 * This drives a full-day labour-strain estimate for someone working through
 * the afternoon, not a "is it nice out" signal for a guest.
 */
const HOT_TEMPERATURE_THRESHOLD = 90

/**
 * Reused from lib/weather/tomorrow.ts rather than picked independently.
 *
 * The scoping note for this module guessed 60 and suggested aligning it with
 * CLEAR_PRECIP_PROBABILITY inverted; the real file already exports an explicit
 * RAINY_PRECIP_PROBABILITY (40), with CLEAR (25) as a deliberately
 * non-complementary second threshold and an intentional dead band between
 * them. Importing the existing "rainy" bar is what actually delivers the
 * intent behind that note: a day cannot read rainy to the guest nudge and
 * dry to friction scoring.
 */
const RAINY_PROBABILITY_THRESHOLD = RAINY_PRECIP_PROBABILITY

/**
 * DayForecast carries no isHot/isRainy — those booleans belong to the realtime
 * WeatherContext type in the same module. Thresholds are therefore applied
 * here, against temperatureMax/precipitationProbability directly.
 */
export function weatherScore(forecast: DayForecast): number {
  let score = 0
  if (forecast.temperatureMax >= HOT_TEMPERATURE_THRESHOLD) score += WEATHER_HOT_WEIGHT
  if (forecast.precipitationProbability >= RAINY_PROBABILITY_THRESHOLD) score += WEATHER_RAINY_WEIGHT
  return score
}

// ── Component: weekend ──────────────────────────────────────────────────────

const WEEKEND_WEIGHT = 0.10

/** Friday, Saturday or Sunday checkout. */
export function weekendScore(date: Date): number {
  const day = date.getDay() // 0=Sun .. 6=Sat
  return day === 5 || day === 6 || day === 0 ? WEEKEND_WEIGHT : 0
}

// ── Component: holiday egress window ────────────────────────────────────────
//
// Computed algorithmically — no stored date table, so no annual maintenance
// and no year at which this quietly stops covering anything. No holiday
// library: it would not cover the seasonal windows below (ski/foliage/lake are
// FieldStay business rules, not calendar facts), so a dependency would have
// solved part of one component.

const HOLIDAY_WEIGHT = 0.15

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  // month: 0-indexed (JS convention). weekday: 0=Sun..6=Sat. n: 1 = first.
  const first  = new Date(year, month, 1)
  const offset = (weekday - first.getDay() + 7) % 7
  return new Date(year, month, 1 + offset + (n - 1) * 7)
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const lastDay = new Date(year, month + 1, 0) // day 0 of next month
  const offset  = (lastDay.getDay() - weekday + 7) % 7
  return new Date(year, month, lastDay.getDate() - offset)
}

function saturdayBefore(monday: Date): Date {
  const saturday = new Date(monday)
  saturday.setDate(monday.getDate() - 2)
  return saturday
}

function memorialDayWeekend(year: number): { start: Date; end: Date } {
  const monday = lastWeekdayOfMonth(year, 4, 1) // last Monday in May
  return { start: saturdayBefore(monday), end: monday }
}

function laborDayWeekend(year: number): { start: Date; end: Date } {
  const monday = nthWeekdayOfMonth(year, 8, 1, 1) // first Monday in September
  return { start: saturdayBefore(monday), end: monday }
}

function thanksgivingWeek(year: number): { start: Date; end: Date } {
  const thursday  = nthWeekdayOfMonth(year, 10, 4, 4) // 4th Thursday in November
  const wednesday = new Date(thursday)
  wednesday.setDate(thursday.getDate() - 1)
  const sunday = new Date(thursday)
  sunday.setDate(thursday.getDate() + 3)
  return { start: wednesday, end: sunday }
}

function holidayWindows(year: number): { start: Date; end: Date }[] {
  return [
    memorialDayWeekend(year),
    { start: new Date(year, 6, 3), end: new Date(year, 6, 5) }, // July 4th +/- 1
    laborDayWeekend(year),
    thanksgivingWeek(year),
    // Dec 24 through Jan 1. The end crosses into the next year, which is why
    // the check below also tests the PREVIOUS year's windows: Jan 1 itself
    // falls inside the window opened the December before.
    { start: new Date(year, 11, 24), end: new Date(year + 1, 0, 1) },
  ]
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function holidayScore(date: Date): number {
  const day  = startOfLocalDay(date)
  const year = day.getFullYear()
  const windows = [...holidayWindows(year), ...holidayWindows(year - 1)]
  return windows.some((w) => day >= startOfLocalDay(w.start) && day <= startOfLocalDay(w.end))
    ? HOLIDAY_WEIGHT
    : 0
}

// ── Component: seasonal profile ─────────────────────────────────────────────
//
// Fixed MM-DD windows, not per-property date overrides. A rough proxy, fine
// for an internal ops signal, and it must never appear in customer-facing copy
// as a precision claim. A 'custom' profile with property-level overrides can
// be added later without touching anything else here.

interface SeasonalWindow { startMD: string; endMD: string; score: number }

const SEASONAL_WINDOWS: Record<string, SeasonalWindow[]> = {
  none:             [],
  summer_lake:      [{ startMD: '05-25', endMD: '09-05', score: 0.15 }],
  fall_foliage:     [{ startMD: '09-15', endMD: '11-05', score: 0.15 }],
  ski:              [{ startMD: '11-15', endMD: '03-31', score: 0.15 }],
  coastal_summer:   [{ startMD: '05-25', endMD: '09-05', score: 0.15 }],
  // Flat year-round traffic is itself the signal, not a missing entry.
  year_round_urban: [],
}

// Spring break is deliberately NOT in this table — see springBreakScore. This
// table is keyed by what KIND of destination a property is; spring-break
// timing is driven by WHERE it is. Nesting one inside the other was tried and
// reverted: it gave every summer_lake property one window regardless of state.

function monthDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day   = String(date.getDate()).padStart(2, '0')
  return `${month}-${day}`
}

function withinMD(md: string, startMD: string, endMD: string): boolean {
  // A window whose start sorts after its end crosses Dec 31 (ski: 11-15 ->
  // 03-31) and is satisfied by either side of the boundary.
  if (startMD > endMD) return md >= startMD || md <= endMD
  return md >= startMD && md <= endMD
}

function matchedWindow(profile: string, date: Date): SeasonalWindow | null {
  const md = monthDay(date)
  return (SEASONAL_WINDOWS[profile] ?? []).find((w) => withinMD(md, w.startMD, w.endMD)) ?? null
}

/**
 * Single source of truth for "is this property inside its seasonal window",
 * shared with interactionScore — the window-matching logic is not duplicated.
 */
export function isSeasonalWindowActive(profile: string, date: Date): boolean {
  return matchedWindow(profile, date) !== null
}

export function seasonalScore(profile: string, date: Date): number {
  return matchedWindow(profile, date)?.score ?? 0
}

// ── Component: spring break (region-keyed, not profile-keyed) ───────────────

type SpringBreakRegion =
  | 'south_gulf' | 'midwest_plains' | 'west_coast'
  | 'northeast'  | 'southwest'      | 'upper_south'

/**
 * Every US state plus DC is mapped. There is no fall-through-to-zero case left
 * for a real property, which is deliberate — see the AK/HI note below.
 *
 * Mountain West (CO/ID/MT/WY/UT) maps onto west_coast — the same window, not
 * a new region. Southwest (AZ/NM/NV) is its own region because it draws from
 * the South (via Texas) and the West Coast (via California) at their
 * respective different times.
 *
 * AK and HI map onto west_coast too, and this is NOT the "guess a region for
 * an unmapped state" that the rest of this table warns against. It is a
 * stated observation — both run mid-March to the first week of April — matched
 * to the region whose window already covers that band: west_coast is
 * 03-18..04-10, where northeast runs a week later and midwest_plains ends too
 * early. The earlier reasoning for leaving them out was about Hawaii being a
 * spring-break DESTINATION rather than an origin market; that argument was
 * about which market's calendar to use, and a directly observed window
 * supersedes it. Anything beyond these two needs the same kind of evidence —
 * a window someone has actually observed, not a nearby state's.
 */
const STATE_SPRING_BREAK_REGION: Record<string, SpringBreakRegion> = {
  AL: 'south_gulf', AR: 'south_gulf', FL: 'south_gulf', GA: 'south_gulf',
  LA: 'south_gulf', MS: 'south_gulf', NC: 'south_gulf', SC: 'south_gulf',
  TN: 'south_gulf', TX: 'south_gulf', KY: 'south_gulf', OK: 'south_gulf',

  IL: 'midwest_plains', IN: 'midwest_plains', IA: 'midwest_plains', KS: 'midwest_plains',
  MI: 'midwest_plains', MN: 'midwest_plains', MO: 'midwest_plains', NE: 'midwest_plains',
  ND: 'midwest_plains', OH: 'midwest_plains', SD: 'midwest_plains', WI: 'midwest_plains',

  CA: 'west_coast', OR: 'west_coast', WA: 'west_coast',
  CO: 'west_coast', ID: 'west_coast', MT: 'west_coast', WY: 'west_coast', UT: 'west_coast',

  AZ: 'southwest', NM: 'southwest', NV: 'southwest',

  CT: 'northeast', MA: 'northeast', ME: 'northeast', NH: 'northeast',
  NJ: 'northeast', NY: 'northeast', PA: 'northeast', RI: 'northeast', VT: 'northeast',
  DE: 'northeast', MD: 'northeast', DC: 'northeast', // DC is not a state, but properties.state may hold it

  VA: 'upper_south', WV: 'upper_south',

  // Mid-March to the first week of April, which is west_coast's window. See
  // the note above — an observed window, not an inferred one.
  AK: 'west_coast', HI: 'west_coast',
}

/**
 * properties.state is FREE TEXT, captured from a plain form field, and live
 * rows hold both 'AL' and 'Alabama' for the same state — more of them spelled
 * out than abbreviated. Without this map the region lookup above would miss
 * the majority of the real portfolio and score 0 with no symptom.
 *
 * This is spelling normalisation, not a coverage decision: every state is
 * listed here so any spelling resolves to its code, and which codes carry a
 * spring-break region is decided in STATE_SPRING_BREAK_REGION above.
 */
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC',
}

/** 'al' | 'AL' | ' Alabama ' -> 'AL'. Anything unrecognised returns null. */
export function normalizeStateCode(state: string | null | undefined): string | null {
  if (!state) return null
  const trimmed = state.trim()
  if (!trimmed) return null

  const upper = trimmed.toUpperCase()
  if (upper.length === 2) return upper

  return STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null
}

/**
 * Each window blends that region's earlier college wave with its later K-12
 * wave into one band. Splitting them would add real complexity for marginal
 * gain in a signal this file already states is a rough proxy. Reasoned from a
 * regional description, not verified against a school-calendar dataset.
 */
const SOUTH_GULF_WINDOW = { startMD: '03-01', endMD: '03-27' }
const WEST_COAST_WINDOW = { startMD: '03-18', endMD: '04-10' }

/**
 * Shifts an MM-DD window by N days. upper_south is DERIVED from south_gulf
 * through this rather than written as a second literal, so it cannot drift out
 * of sync when south_gulf's dates change. REFERENCE_YEAR is arbitrary (any
 * non-leap year) and is only ever used for the arithmetic.
 */
function shiftWindowByDays(
  window: { startMD: string; endMD: string },
  days:   number,
): { startMD: string; endMD: string } {
  const REFERENCE_YEAR = 2027
  const shift = (md: string): string => {
    const [month, day] = md.split('-').map(Number) as [number, number]
    const d = new Date(REFERENCE_YEAR, month - 1, day)
    d.setDate(d.getDate() + days)
    return monthDay(d)
  }
  return { startMD: shift(window.startMD), endMD: shift(window.endMD) }
}

/**
 * Earliest start, latest end. southwest is derived from south_gulf +
 * west_coast through this for the same drift-safety reason as above — it was
 * a hardcoded literal once and went stale the first time south_gulf moved.
 */
function unionWindow(
  a: { startMD: string; endMD: string },
  b: { startMD: string; endMD: string },
): { startMD: string; endMD: string } {
  return {
    startMD: a.startMD < b.startMD ? a.startMD : b.startMD,
    endMD:   a.endMD   > b.endMD   ? a.endMD   : b.endMD,
  }
}

const SPRING_BREAK_REGION_WINDOWS: Record<SpringBreakRegion, { startMD: string; endMD: string }> = {
  south_gulf:     SOUTH_GULF_WINDOW,
  midwest_plains: { startMD: '03-08', endMD: '03-24' }, // mid-March cluster
  west_coast:     WEST_COAST_WINDOW,
  northeast:      { startMD: '03-18', endMD: '04-15' }, // latest wave, often tied to Easter
  southwest:      unionWindow(SOUTH_GULF_WINDOW, WEST_COAST_WINDOW),
  upper_south:    shiftWindowByDays(SOUTH_GULF_WINDOW, 7), // VA/WV
}

/** Real, but generally smaller than peak summer's 0.15. */
const SPRING_BREAK_WEIGHT = 0.10

/**
 * Only destinations where spring break actually drives leisure travel.
 *
 * `ski` is left OUT deliberately rather than silently included: spring skiing
 * overlaps the ski profile's own Nov-Mar window, so whether a March booking
 * should count once (seasonal) or twice (seasonal + spring break) is a product
 * call, not a default to bury in code. fall_foliage, year_round_urban and none
 * get nothing — spring break is not their travel timing.
 */
const SPRING_BREAK_ELIGIBLE_PROFILES = new Set(['summer_lake', 'coastal_summer'])

export function springBreakScore(
  state:   string | null,
  profile: string,
  date:    Date,
): number {
  if (!SPRING_BREAK_ELIGIBLE_PROFILES.has(profile)) return 0

  const code = normalizeStateCode(state)
  if (!code) return 0

  const region = STATE_SPRING_BREAK_REGION[code]
  // Every US state and DC is mapped, so this is reached only by a
  // properties.state value that is not a US state at all — free-text
  // column, so that is a real input, not an impossible one.
  if (!region) return 0

  const window = SPRING_BREAK_REGION_WINDOWS[region]
  return withinMD(monthDay(date), window.startMD, window.endMD) ? SPRING_BREAK_WEIGHT : 0
}

// ── Component: compounding interaction (tiered, mutually exclusive) ─────────
//
// ONE component, not several additive terms. Independent terms would
// double-count a shared factor the moment two conditions overlap — a holiday
// that is also a weekend inside an active season would count "season" twice
// across a holiday x season and a weekend x season term.
//
// Season is an INPUT, not a requirement: a holiday landing on a Saturday
// compounds whether or not the property has a seasonal profile at all.
//
// Placeholder weights, to tune before this drives anything customer-facing.
// The ORDERING is reasoned: holiday x weekend outranks holiday x season
// because both of its factors pin to the same specific DATE, whereas a
// seasonal window is a diffuse multi-week period. The exact gaps between
// tiers are still a guess.
const WEEKEND_SEASON_WEIGHT         = 0.08
const HOLIDAY_SEASON_WEIGHT         = 0.12
const HOLIDAY_WEEKEND_WEIGHT        = 0.14
const HOLIDAY_WEEKEND_SEASON_WEIGHT = 0.20

export function interactionScore(profile: string, date: Date): number {
  const isWeekend        = weekendScore(date) > 0
  const isHoliday        = holidayScore(date) > 0
  const isSeasonalActive = isSeasonalWindowActive(profile, date)

  if (isHoliday && isWeekend && isSeasonalActive) return HOLIDAY_WEEKEND_SEASON_WEIGHT
  if (isHoliday && isWeekend)                     return HOLIDAY_WEEKEND_WEIGHT
  if (isHoliday && isSeasonalActive)              return HOLIDAY_SEASON_WEIGHT
  if (isWeekend && isSeasonalActive)              return WEEKEND_SEASON_WEIGHT
  return 0
}

// ── Reserved: local events ──────────────────────────────────────────────────
//
// No localEventsScore() exists, and no placeholder table or UI was created for
// one — a mechanism nobody maintains is worse than an honest absence, because
// it creates the appearance of coverage that silently does not work.
//
// When it is built it becomes the ONLY new call site: drop its result into
// FrictionComponents.localEvents in the cron. Nothing else in this module
// changes.
//
// The mechanism is NOT PM-entered event data. Two categories were fully
// designed and then explicitly CLOSED, not deferred — do not resurrect either
// without a specific reason the overlap argument is wrong:
//   - College sports proximity / rivalry week and pro sports postseason:
//     almost all of their signal is already caught by `weekend` (college games
//     are nearly always Saturdays) and `holiday` (rivalry week is defined by
//     its proximity to Thanksgiving). Not worth a 500-school geography dataset
//     and a manual playoff toggle for the residue.
//   - Bowl-season host cities: all six New Year's Six cities are large,
//     diversified metros where one more game is a rounding error against
//     existing hospitality volume.
// One category stays genuinely open: true long-tail events (conventions,
// concerts, fishing tournaments), which do not reliably land on weekends,
// holidays or seasonal windows. The only architecture that satisfies "do not
// burden the PM" there is a paid demand-intelligence API — a real phase-2
// decision, not a seam to fake today.

// ── Reasoning strings for the dashboard ─────────────────────────────────────

const COMPONENT_LABELS: Record<keyof FrictionComponents, string> = {
  crewDurationVsBaseline: 'crew pace vs. the turnover window',
  weather:                'weather',
  weekend:                'weekend checkout',
  holiday:                'holiday travel window',
  seasonal:               'peak season',
  springBreak:            'spring break',
  interaction:            'compounding calendar pressure',
  localEvents:            'local events',
}

/**
 * The highest-weighted non-zero components, worst first — deterministic and
 * template-built, never LLM-generated, same as checklist-signals' `reason`.
 */
export function topFrictionReasons(
  breakdown: Partial<Record<keyof FrictionComponents, number>>,
  limit = 2,
): string[] {
  return (Object.entries(breakdown) as [keyof FrictionComponents, number][])
    .filter(([, value]) => typeof value === 'number' && value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => COMPONENT_LABELS[key] ?? key)
}
