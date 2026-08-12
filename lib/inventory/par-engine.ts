/**
 * Dynamic PAR resolution engine — pure, synchronous, dependency-free.
 *
 * The database stores CONFIG (par_mode, smart_group, base_qty, auto_adjust);
 * this module holds the FORMULAS. inventory_items.par_level is a
 * server-maintained cache of resolvePar()'s output for 'smart' items and a
 * plain manual value for 'static' items. Recompute happens on write (Inngest
 * `inventory/par-recompute-requested`, pass 2), never on read — the crew PWA,
 * PO generation, and low-stock checks keep reading par_level untouched.
 *
 * Resolution priority for par_mode = 'smart':
 *   1. Historical consumption — once >= HISTORICAL_MIN_SAMPLES count-derived
 *      samples exist AND the item has auto_adjust = true.
 *   2. Smart-group formula — ceil(base_qty × property[multiplier] × (1 + buffer)).
 * par_mode = 'static' short-circuits: the stored par_level is returned as-is.
 */

// The two enum unions live in types/database.ts with every other Postgres
// enum, because scripts/check-type-drift.mjs parses that file to diff them
// against the live enum labels. Imported back here (type-only, so this module
// stays runtime-dependency-free) and re-exported, so existing callers that
// import them from the engine keep working.
import type { ParMode, ParSmartGroup } from '@/types/database'
export type { ParMode, ParSmartGroup }

export interface SmartGroupSpec {
  /** properties column the formula scales by */
  multiplierKey: 'bathrooms' | 'bedrooms' | 'max_guests'
  /** safety buffer as a fraction, e.g. 0.15 = +15% */
  buffer: number
  label: string
}

/** Global defaults. Changing a value here requires a recompute broadcast
 *  (pass 2) to refresh cached par_levels — never a data migration. */
export const PAR_SMART_GROUPS: Record<ParSmartGroup, SmartGroupSpec> = {
  bathroom_essential: { multiplierKey: 'bathrooms',  buffer: 0.15, label: 'Bathroom essential (scales with bathrooms)' },
  bedroom_essential:  { multiplierKey: 'bedrooms',   buffer: 0.20, label: 'Bedroom essential (scales with bedrooms)' },
  guest_consumable:   { multiplierKey: 'max_guests', buffer: 0.10, label: 'Guest consumable (scales with max guests)' },
}

/** Historical engine only activates with at least this many consumption samples. */
export const HISTORICAL_MIN_SAMPLES = 3
/** Safety buffer applied on top of the historical expected usage. */
export const HISTORICAL_BUFFER = 0.20
/** Historical par never resolves below this floor. */
export const HISTORICAL_FLOOR = 2

/**
 * Nights assumed for a property whose own bookings cannot tell us better.
 * Only reachable when a property has fewer than STAY_LENGTH_MIN_BOOKINGS
 * qualifying stays — not a value anyone stores.
 */
export const DEFAULT_STAY_LENGTH_NIGHTS = 3
/**
 * Bookings a property needs before its OWN average is trusted over the
 * default. Same reasoning as HISTORICAL_MIN_SAMPLES, and the live data is why
 * it is not 1: on 2026-08-11 one property's single booking was a 12-night
 * stay, which would have quadrupled every historical par it ever resolves.
 */
export const STAY_LENGTH_MIN_BOOKINGS = 3

export interface ParPropertyContext {
  bathrooms:       number | null
  bedrooms:        number
  max_guests:      number
  /**
   * Nights of a typical stay, DERIVED from the property's own bookings —
   * NOT properties.avg_stay_length, which has no editor anywhere and is a
   * literal 0 on most live rows. null means "too few bookings to say", and
   * resolves to DEFAULT_STAY_LENGTH_NIGHTS. See derive_property_stay_lengths
   * (migration 20260811210000) and recompute-par.ts.
   */
  avg_stay_length: number | null
}

export interface ParItemConfig {
  par_mode:    ParMode
  smart_group: ParSmartGroup | null
  base_qty:    number
  /** current stored par_level — returned unchanged for 'static' items */
  par_level:   number
  auto_adjust: boolean
}

export interface ParConsumptionStats {
  avg_rate_per_guest_night: number
  sample_count:             number
}

export type ParSource = 'static' | 'historical' | 'smart_formula'

export interface ResolvedPar {
  par:    number
  source: ParSource
}

/**
 * The scaling factor a smart group applies at this property: the property's
 * own bedroom / bathroom / guest count, times the group's safety buffer.
 *
 * Shared by smartFormulaPar and rebaseParFromTarget so the forward and inverse
 * directions can never drift apart — a re-based base_qty that does not
 * reproduce the PM's number is the whole failure this helper prevents.
 */
export function smartScaleFactor(group: ParSmartGroup, property: ParPropertyContext): number {
  const spec = PAR_SMART_GROUPS[group]
  const raw  = property[spec.multiplierKey]
  // bathrooms is nullable (numeric, half-baths allowed) — a property with no
  // metadata yet resolves against 1 unit so a template apply never writes 0.
  const multiplier = typeof raw === 'number' && raw > 0 ? raw : 1
  return multiplier * (1 + spec.buffer)
}

function smartFormulaPar(config: ParItemConfig, property: ParPropertyContext): number {
  // The CHECK constraint guarantees smart rows carry a group, but the resolver
  // must still be total: a malformed row degrades to the stored value rather
  // than throwing inside an Inngest step.
  if (!config.smart_group) return Math.max(Math.ceil(config.par_level), 1)
  return Math.max(Math.ceil(config.base_qty * smartScaleFactor(config.smart_group, property)), 1)
}

function historicalPar(stats: ParConsumptionStats, property: ParPropertyContext): number {
  const guests = property.max_guests > 0 ? property.max_guests : 2
  const nights = property.avg_stay_length && property.avg_stay_length > 0
    ? property.avg_stay_length
    : DEFAULT_STAY_LENGTH_NIGHTS
  const expected = stats.avg_rate_per_guest_night * guests * nights
  return Math.max(Math.ceil(expected * (1 + HISTORICAL_BUFFER)), HISTORICAL_FLOOR)
}

export function resolvePar(
  config: ParItemConfig,
  property: ParPropertyContext,
  stats: ParConsumptionStats | null
): ResolvedPar {
  if (config.par_mode === 'static') {
    return { par: config.par_level, source: 'static' }
  }
  if (config.auto_adjust && stats && stats.sample_count >= HISTORICAL_MIN_SAMPLES && stats.avg_rate_per_guest_night > 0) {
    return { par: historicalPar(stats, property), source: 'historical' }
  }
  return { par: smartFormulaPar(config, property), source: 'smart_formula' }
}

/** The par config a PM's manual edit resolves to. */
export interface ParRebase {
  par_mode:    ParMode
  smart_group: ParSmartGroup | null
  base_qty:    number
  par_level:   number
  auto_adjust: boolean
}

/**
 * A PM typed a par level. Turn it into config that KEEPS the item scaling,
 * with their number as the new baseline.
 *
 * Before this existed, the inline editor wrote par_level directly on any item
 * and the next recompute overwrote it — a smart item's par_level is a cache of
 * resolvePar(), so the PM's number survived exactly until the next property
 * edit or consumption sample. Silently. This inverts the formula instead:
 * store a base_qty that REPRODUCES their number at this property's current
 * size, so the edit is honoured now and still scales if the property changes.
 *
 * THE MIDPOINT IS NOT A ROUNDING PREFERENCE, IT IS THE CORRECT INVERSE.
 * ceil(x) === target iff target - 1 < x <= target, so any base in
 * ((target-1)/k, target/k] works in real arithmetic. The obvious endpoint
 * target/k is exactly representable almost never: 11/1.15*1.15 is
 * 11.000000000000002, which ceils to 12, so the PM types 11 and sees 12. That
 * endpoint is wrong for 1337 of 8400 (target, multiplier, group) combinations
 * actually reachable here. The midpoint (target-0.5)/k absorbs half a unit of
 * float error and round-trips all 8400.
 *
 * auto_adjust is turned OFF. The historical branch ignores base_qty entirely,
 * so leaving it on would let learned consumption supersede the number the PM
 * just explicitly set — the same silent-override surprise this function
 * exists to remove, only slower. auto_adjust is precisely the "let history
 * take over" switch, and an edit is the only signal the UI can currently send.
 *
 * A target below 1 goes STATIC rather than re-basing. Partly arithmetic — the
 * inverse of 0 is negative — but mostly meaning: "0" is a PM saying they do
 * not stock this item here, which is a fixed number, not a scaling one.
 */
export function rebaseParFromTarget(
  target: number,
  config: { smart_group: ParSmartGroup | null },
  property: ParPropertyContext,
): ParRebase {
  const level = Number.isFinite(target) && target > 0 ? target : 0

  // No group means nothing to scale BY, so there is no smart config to write.
  if (level < 1 || !config.smart_group) {
    return { par_mode: 'static', smart_group: null, base_qty: 1, par_level: level, auto_adjust: false }
  }

  const k = smartScaleFactor(config.smart_group, property)
  return {
    par_mode:    'smart',
    smart_group: config.smart_group,
    base_qty:    (level - 0.5) / k,
    par_level:   level,
    auto_adjust: false,
  }
}

export interface ParConfigInput {
  par_mode:    ParMode
  smart_group: ParSmartGroup | null
  base_qty:    number
}

/** Coerces client-submitted par config into a DB-valid shape: static rows
 *  never carry a group; smart rows must name a valid group or degrade to
 *  static; base_qty is clamped positive. Server actions call this so the
 *  smart_group_matches_mode CHECK can never reject a write. */
export function normalizeParConfig(input: ParConfigInput): ParConfigInput {
  const base_qty = Number.isFinite(input.base_qty) && input.base_qty > 0 ? input.base_qty : 1
  if (input.par_mode === 'smart' && input.smart_group && input.smart_group in PAR_SMART_GROUPS) {
    return { par_mode: 'smart', smart_group: input.smart_group, base_qty }
  }
  return { par_mode: 'static', smart_group: null, base_qty }
}
