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
 * properties.seasonal_profile remains, NULLABLE, as the override: a non-null
 * value is a deliberate human correction and always wins. NULL means "derive".
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
const ZIP_SEASONAL_PROFILE: Record<string, SeasonalProfile> = {
  // ── Alabama lakes — Lake Martin, Logan Martin, Lay ─────────────────────────
  '35010': 'summer_lake', // Alexander City
  '35044': 'summer_lake', // Childersburg
  '35136': 'summer_lake', // Goodwater
  '36850': 'summer_lake', // Camp Hill
  '36853': 'summer_lake', // Dadeville
  '36861': 'summer_lake', // Jacksons Gap

  // ── Gulf coast ────────────────────────────────────────────────────────────
  '36542': 'coastal_summer', // Gulf Shores
  '36561': 'coastal_summer', // Orange Beach
  '36535': 'coastal_summer', // Foley
  '32501': 'coastal_summer', // Pensacola
  '32502': 'coastal_summer',
  '32503': 'coastal_summer',
  '32507': 'coastal_summer', // Perdido Key
  '32550': 'coastal_summer', // Miramar Beach
  '32541': 'coastal_summer', // Destin
  '32459': 'coastal_summer', // Santa Rosa Beach / 30A
  '32413': 'coastal_summer', // Panama City Beach
  '32456': 'coastal_summer', // Port St. Joe

  // ── Atlantic coast ────────────────────────────────────────────────────────
  '29582': 'coastal_summer', // North Myrtle Beach
  '29577': 'coastal_summer', // Myrtle Beach
  '29572': 'coastal_summer',
  '27959': 'coastal_summer', // Nags Head
  '27949': 'coastal_summer', // Kitty Hawk
  '02554': 'coastal_summer', // Nantucket
  '02557': 'coastal_summer', // Oak Bluffs
  '02539': 'coastal_summer', // Edgartown
  '04046': 'coastal_summer', // Kennebunkport
  '08226': 'coastal_summer', // Ocean City NJ

  // ── Fall foliage ──────────────────────────────────────────────────────────
  '22835': 'fall_foliage', // Luray VA — Shenandoah / Skyline Drive
  '22851': 'fall_foliage', // Stanley VA
  '22740': 'fall_foliage', // Sperryville VA
  '28751': 'fall_foliage', // Maggie Valley NC
  '28786': 'fall_foliage', // Waynesville NC
  '28604': 'fall_foliage', // Banner Elk NC
  // The Smokies. See the note below — this is the judgement call in the table.
  '37738': 'fall_foliage', // Gatlinburg
  '37862': 'fall_foliage', // Sevierville
  '37863': 'fall_foliage', // Pigeon Forge
  '37876': 'fall_foliage', // Sevierville / Kodak

  // ── Ski ───────────────────────────────────────────────────────────────────
  '80424': 'ski', // Breckenridge
  '80435': 'ski', // Keystone / Dillon
  '80443': 'ski', // Frisco
  '80498': 'ski', // Silverthorne
  '80482': 'ski', // Winter Park
  '80487': 'ski', // Steamboat Springs
  '80488': 'ski',
  '81657': 'ski', // Vail
  '81620': 'ski', // Avon
  '81632': 'ski', // Edwards
  '81611': 'ski', // Aspen
  '81615': 'ski', // Snowmass Village
  '81435': 'ski', // Telluride
  '81224': 'ski', // Crested Butte
  '84060': 'ski', // Park City UT
  '84098': 'ski',
  '83001': 'ski', // Jackson WY
  '83025': 'ski', // Teton Village WY
  '59937': 'ski', // Whitefish MT
  '59716': 'ski', // Big Sky MT
  '83340': 'ski', // Ketchum ID
  '83353': 'ski', // Sun Valley ID
  '96150': 'ski', // South Lake Tahoe CA
  '96145': 'ski', // Tahoe City CA
  '93546': 'ski', // Mammoth Lakes CA
  '05672': 'ski', // Stowe VT
  '05751': 'ski', // Killington VT
  '03860': 'ski', // North Conway NH
  '03251': 'ski', // Lincoln NH
  '12946': 'ski', // Lake Placid NY

  // ── Year-round urban ──────────────────────────────────────────────────────
  // Flat traffic is itself the signal: these get no seasonal bump, which is a
  // classification rather than an absence.
  '78701': 'year_round_urban', // Austin
  '78702': 'year_round_urban',
  '78703': 'year_round_urban',
  '78704': 'year_round_urban',
  '35201': 'year_round_urban', // Birmingham
  '35203': 'year_round_urban',
  '35205': 'year_round_urban',
  '35209': 'year_round_urban',
  '37201': 'year_round_urban', // Nashville
  '37203': 'year_round_urban',
  '37206': 'year_round_urban',
  '30303': 'year_round_urban', // Atlanta
  '30308': 'year_round_urban',
  '30309': 'year_round_urban',
}

/**
 * The market profile for a ZIP, or 'none' when it is unmapped or unparseable.
 *
 * 'none' is a real answer here, not a failure: it contributes 0 to the
 * composite, exactly as an unclassified property does, so a market nobody has
 * mapped yet costs accuracy on the seasonal component and nothing else.
 */
export function seasonalProfileForZip(zip: string | null | undefined): SeasonalProfile {
  const normalized = normalizeZip(zip)
  if (!normalized) return 'none'
  return ZIP_SEASONAL_PROFILE[normalized] ?? 'none'
}

/**
 * The profile to score a property on: a human override if one is set,
 * otherwise the market derived from its ZIP.
 *
 * This is the single place the two are combined. The override column is
 * NULLABLE precisely so "nobody has said" and "somebody chose none" stay
 * distinguishable — the same distinction properties.sponsor_assignment_mode
 * exists to preserve, and for the same reason: without it, a deliberate
 * 'none' is indistinguishable from an unset row and the derivation would
 * silently overrule a human every night.
 */
export function resolveSeasonalProfile(
  override: SeasonalProfile | null | undefined,
  zip:      string | null | undefined,
): SeasonalProfile {
  return override ?? seasonalProfileForZip(zip)
}
