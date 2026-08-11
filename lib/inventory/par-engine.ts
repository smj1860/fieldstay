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

export interface ParPropertyContext {
  bathrooms:       number | null
  bedrooms:        number
  max_guests:      number
  /** properties.avg_stay_length — nights of a typical stay */
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

function smartFormulaPar(config: ParItemConfig, property: ParPropertyContext): number {
  // The CHECK constraint guarantees smart rows carry a group, but the resolver
  // must still be total: a malformed row degrades to the stored value rather
  // than throwing inside an Inngest step.
  if (!config.smart_group) return Math.max(Math.ceil(config.par_level), 1)
  const spec = PAR_SMART_GROUPS[config.smart_group]
  const raw = property[spec.multiplierKey]
  // bathrooms is nullable (numeric, half-baths allowed) — a property with no
  // metadata yet resolves against 1 unit so a template apply never writes 0.
  const multiplier = typeof raw === 'number' && raw > 0 ? raw : 1
  return Math.max(Math.ceil(config.base_qty * multiplier * (1 + spec.buffer)), 1)
}

function historicalPar(stats: ParConsumptionStats, property: ParPropertyContext): number {
  const guests = property.max_guests > 0 ? property.max_guests : 2
  const nights = property.avg_stay_length && property.avg_stay_length > 0 ? property.avg_stay_length : 3
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
