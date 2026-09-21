/**
 * ZIP -> seasonal market profile.
 *
 * The seasonal component asks a question about a MARKET, not about a house: a
 * cabin in Breckenridge follows the ski calendar whether or not it is
 * slopeside, and every rental in the Gulf Shores ZIPs follows the same summer
 * curve. So the profile is derived from where the property is, and a PM is
 * never asked to classify it — which is the whole promise of this product:
 * take the upkeep OFF the PM.
 *
 * Resolved at SCORING time, not written into the property on save. There are
 * already three paths that create a property (createProperty, the PMS
 * normalised upsert, the geocoding backfill cron) and wiring a derivation into
 * each is precisely the drift this codebase keeps paying for. Deriving at read
 * time also means expanding the table below takes effect for every existing
 * property on the next 2am run, with no backfill and nothing to remember.
 *
 * properties.seasonal_profile remains as the override, and is an ARRAY: a
 * non-empty value is a deliberate human correction and always wins, EMPTY
 * means "derive". A market can legitimately map to more than one profile —
 * Gatlinburg has real summer park tourism AND a real fall-foliage run, which
 * a single value could only ever describe half of.
 *
 * PARTIAL BY DESIGN, and safely so. An unmapped ZIP returns 'none', which
 * contributes exactly 0 — the same honest absence an unclassified property has
 * today. Adding a market is a deliberate act with a real basis, never a guess
 * from a neighbouring ZIP: a wrong profile does not fail loudly, it quietly
 * scores a property against the wrong calendar for months.
 */

import type { SeasonalProfile } from '@/types/database'

/**
 * properties.zip is FREE TEXT and the live column proves it: rows hold
 * '36850-3722' (ZIP+4), 'TX 78703' (state prefix pasted in), and NULL. A
 * lookup keyed on the raw string would miss all but the tidy ones — the same
 * failure properties.state had, found the same way.
 *
 * Takes the first five-digit run anywhere in the value, which handles every
 * shape above and rejects anything that has no ZIP in it at all.
 */
export function normalizeZip(zip: string | null | undefined): string | null {
  if (!zip) return null
  return /\d{5}/.exec(zip)?.[0] ?? null
}

/**
 * The mapped markets.
 *
 * Five-digit ZIPs rather than three-digit prefixes, deliberately. A prefix
 * covers a whole region: 804xx is Breckenridge AND suburban Boulder, and
 * classifying a Boulder rental as 'ski' would inflate its friction score every
 * day for four and a half months. Precision with an honest 'none' fallback
 * beats coverage that is wrong in specific places.
 */
const ZIP_SEASONAL_PROFILE: Record<string, SeasonalProfile[]> = {
  // ── Alabama lakes — Lake Martin, Logan Martin, Lay ─────────────────────────
  '35010': ['summer_vacation'], // Alexander City
  '35044': ['summer_vacation'], // Childersburg
  '35136': ['summer_vacation'], // Goodwater
  '36850': ['summer_vacation'], // Camp Hill
  '36853': ['summer_vacation'], // Dadeville
  '36861': ['summer_vacation'], // Jacksons Gap

  // ── Gulf coast ────────────────────────────────────────────────────────────
  '36542': ['summer_vacation'], // Gulf Shores
  '36561': ['summer_vacation'], // Orange Beach
  '36535': ['summer_vacation'], // Foley
  '32501': ['summer_vacation'], // Pensacola
  '32502': ['summer_vacation'],
  '32503': ['summer_vacation'],
  '32507': ['summer_vacation'], // Perdido Key
  '32550': ['summer_vacation'], // Miramar Beach
  '32541': ['summer_vacation'], // Destin
  '32459': ['summer_vacation'], // Santa Rosa Beach / 30A
  '32413': ['summer_vacation'], // Panama City Beach
  '32456': ['summer_vacation'], // Port St. Joe

  // ── Atlantic coast ────────────────────────────────────────────────────────
  '29582': ['summer_vacation'], // North Myrtle Beach
  '29577': ['summer_vacation'], // Myrtle Beach
  '29572': ['summer_vacation'],
  '27959': ['summer_vacation'], // Nags Head
  '27949': ['summer_vacation'], // Kitty Hawk
  '02554': ['summer_vacation'], // Nantucket
  '02557': ['summer_vacation'], // Oak Bluffs
  '02539': ['summer_vacation'], // Edgartown
  '04046': ['summer_vacation'], // Kennebunkport
  '08226': ['summer_vacation'], // Ocean City NJ

  // ── Fall foliage ──────────────────────────────────────────────────────────
  '22835': ['fall_foliage'], // Luray VA — Shenandoah / Skyline Drive
  '22851': ['fall_foliage'], // Stanley VA
  '22740': ['fall_foliage'], // Sperryville VA
  '28751': ['fall_foliage'], // Maggie Valley NC
  '28786': ['fall_foliage'], // Waynesville NC
  '28604': ['fall_foliage'], // Banner Elk NC
  // The Smokies carry BOTH, and are the case the array exists for: real
  // summer national-park tourism and a real, arguably bigger, October colour
  // run. As a scalar this was a forced either/or and was recorded as a
  // judgement call; it is not one any more.
  '37738': ['summer_vacation', 'fall_foliage'], // Gatlinburg
  '37862': ['summer_vacation', 'fall_foliage'], // Sevierville
  '37863': ['summer_vacation', 'fall_foliage'], // Pigeon Forge
  '37876': ['summer_vacation', 'fall_foliage'], // Sevierville / Kodak

  // ── Ski ───────────────────────────────────────────────────────────────────
  '80424': ['ski'], // Breckenridge
  '80435': ['ski'], // Keystone / Dillon
  '80443': ['ski'], // Frisco
  '80498': ['ski'], // Silverthorne
  '80482': ['ski'], // Winter Park
  '80487': ['ski'], // Steamboat Springs
  '80488': ['ski'],
  '81657': ['ski'], // Vail
  '81620': ['ski'], // Avon
  '81632': ['ski'], // Edwards
  '81611': ['ski'], // Aspen
  '81615': ['ski'], // Snowmass Village
  '81435': ['ski'], // Telluride
  '81224': ['ski'], // Crested Butte
  '84060': ['ski'], // Park City UT
  '84098': ['ski'],
  '83001': ['ski'], // Jackson WY
  '83025': ['ski'], // Teton Village WY
  '59937': ['ski'], // Whitefish MT
  '59716': ['ski'], // Big Sky MT
  '83340': ['ski'], // Ketchum ID
  '83353': ['ski'], // Sun Valley ID
  '96150': ['ski'], // South Lake Tahoe CA
  '96145': ['ski'], // Tahoe City CA
  '93546': ['ski'], // Mammoth Lakes CA
  '05672': ['ski'], // Stowe VT
  '05751': ['ski'], // Killington VT
  '03860': ['ski'], // North Conway NH
  '03251': ['ski'], // Lincoln NH
  '12946': ['ski'], // Lake Placid NY

  // ── Summer-peaked mountain ────────────────────────────────────────────────
  // Newly mappable. Under the old enum these markets had NO value — 'ski' is
  // wrong (they peak in July, not January) and there was no plain summer
  // option that was not lake- or coast-specific, so they scored 0. Collapsing
  // summer_lake/coastal_summer into summer_vacation is what made them
  // expressible.
  '80829': ['summer_vacation'], // Manitou Springs CO — Pikes Peak gateway

  // ── Year-round urban ──────────────────────────────────────────────────────
  // Flat traffic is itself the signal: these get no seasonal bump, which is a
  // classification rather than an absence.
  '78701': ['year_round_urban'], // Austin
  '78702': ['year_round_urban'],
  '78703': ['year_round_urban'],
  '78704': ['year_round_urban'],
  '35201': ['year_round_urban'], // Birmingham
  '35203': ['year_round_urban'],
  '35205': ['year_round_urban'],
  '35209': ['year_round_urban'],
  '37201': ['year_round_urban'], // Nashville
  '37203': ['year_round_urban'],
  '37206': ['year_round_urban'],
  '30303': ['year_round_urban'], // Atlanta
  '30308': ['year_round_urban'],
  '30309': ['year_round_urban'],
}

/**
 * The market profiles for a ZIP — possibly several — or an EMPTY ARRAY when it
 * is unmapped or unparseable.
 *
 * Empty is a real answer, not a failure: it contributes 0 to the composite,
 * exactly as an unclassified property does, so a market nobody has mapped yet
 * costs accuracy on the seasonal component and nothing else.
 */
export function seasonalProfileForZip(zip: string | null | undefined): SeasonalProfile[] {
  const normalized = normalizeZip(zip)
  if (!normalized) return []
  return ZIP_SEASONAL_PROFILE[normalized] ?? []
}

/**
 * The profiles to score a property on: the human override if one is set,
 * otherwise the markets derived from its ZIP.
 *
 * This is the single place the two are combined. The override is EMPTY by
 * default precisely so "nobody has said" and "somebody chose none" stay
 * distinguishable — `['none']` is a real answer meaning this market has no
 * seasonality, and it must survive rather than be re-derived over. Same
 * distinction properties.sponsor_assignment_mode exists to preserve, and for
 * the same reason: without it the derivation silently overrules a human every
 * night.
 */
export function resolveSeasonalProfile(
  override: SeasonalProfile[] | null | undefined,
  zip:      string | null | undefined,
): SeasonalProfile[] {
  return override?.length ? override : seasonalProfileForZip(zip)
}
