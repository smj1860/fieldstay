// lib/inspections/forms/index.ts
//
// The three platform-owned inspection forms, and the cross-form concern table
// that keeps one physical fault from becoming three work orders.

import { INDOOR_FORM }  from './indoor'
import { OUTDOOR_FORM } from './outdoor'
import { SAFETY_FORM }  from './safety'
import { allItems, type FormDefinition } from './types'

export * from './types'
export { SAFETY_FORM, INDOOR_FORM, OUTDOOR_FORM }

export const INSPECTION_FORMS: FormDefinition[] = [SAFETY_FORM, INDOOR_FORM, OUTDOOR_FORM]

/**
 * Item counts the spec commits to, asserted by the seed test.
 *
 * TOP-LEVEL items only — children and repeat-group members are not counted,
 * matching how §12 numbers them.
 *
 *   safety   40 inspected items + a 2-item sign-off (declaration + signature)
 *   indoor   52, which already includes its three sign-off items — §12.2
 *            numbers them 50–52
 *   outdoor  45 numbered + 3 unnumbered sign-off + 9 well items, the last
 *            counted here even though that section renders only where the
 *            property actually has a well
 */
export const EXPECTED_ROOT_ITEM_COUNTS: Record<string, number> = {
  safety:  42,   // 40 inspected items + the 2-item sign-off
  indoor:  52,
  outdoor: 57,   // 45 numbered + 3 sign-off + 9 well
}

/**
 * THE CROSS-FORM CONCERN TABLE — docs/INSPECTIONS_SPEC.md §12.3.
 *
 * `concern_key` merges the SAME PHYSICAL FAULT observed from more than one
 * vantage point, so that a dead detector asked about on two forms on two
 * cadences produces one work order rather than two. It is narrower than
 * `asset_type` on purpose: a due HVAC filter and a fouled condenser are one
 * asset and two visits.
 *
 * EVERY ENTRY CARRIES A `why`, and that is the enforcement, not decoration.
 * The two failure modes are not symmetric. A MISSED merge produces duplicate
 * work orders — annoying, visible, and someone closes one. A WRONG merge
 * silently folds two real faults into one dispatch, and the second fault is
 * never seen again. Requiring a sentence for each key is what makes the second
 * one a decision somebody made rather than a coincidence of naming.
 *
 * Single-item entries are deliberate and are NOT dead weight: they are a no-op
 * for dedup (a repeat visit within one form is already covered by
 * `form_item_id`), and they exist so a later form adding the same concern
 * adopts the key instead of inventing a second name for it.
 */
export interface ConcernEntry {
  /** Every item key carrying this concern, across all three forms. */
  items: string[]
  /** Why these are ONE fault — or, for a single entry, what it is reserved for. */
  why:   string
}

export const CONCERN_KEY_MAP: Record<string, ConcernEntry> = {
  // ── Genuinely cross-form ──────────────────────────────────────────────────
  gutters_clear: {
    items: ['safety.water.gutters', 'outdoor.roof_drainage.gutters'],
    why:   'One gutter run. Safety asks as freeze/water-intrusion prevention, Outdoor as drainage; a blockage is a single clearing visit.',
  },
  dryer_vent_clear: {
    items: [
      'safety.fire.dryer_vent',
      'indoor.utility_laundry.dryer',
      'outdoor.roof_drainage.dryer_vent_exit',
    ],
    why:   'One vent run seen from three ends — the trap, the hose, the exterior termination. Lint anywhere in it is one cleaning job.',
  },
  walkway_trip_hazard: {
    items: ['safety.structural.walkways', 'outdoor.grounds.driveway', 'outdoor.grounds.walkways'],
    why:   'One uneven approach to the door. Two surfaces and two forms, but a contractor levels the approach once.',
  },
  deck_guardrail: {
    items: ['safety.structural.deck_guardrail', 'outdoor.decks.guardrails'],
    why:   'The same rail. Safety asks about spindle spacing compliance, Outdoor about anchorage; both are the carpenter’s one visit.',
  },
  handrail_secure: {
    items: ['safety.structural.handrails', 'indoor.entry_interior.stairs_handrails'],
    why:   'Interior stair handrails, asked annually on Safety and quarterly on Indoor so a loose rail is not carried for six months.',
  },
  exterior_lighting: {
    items: ['safety.exterior_amenity.exterior_lighting', 'outdoor.exterior_utilities.lighting'],
    why:   'The same fixtures. Safety cares that entryways are lit; Outdoor enumerates motion and dusk-to-dawn. One relamping.',
  },
  gfci_wet_areas: {
    items: [
      'safety.electrical_gas.gfci',
      'indoor.bathrooms.gfci',
      'outdoor.exterior_utilities.exterior_outlets',
    ],
    why:   'GFCI protection across every wet location. An electrician testing and replacing devices does the whole property in one call.',
  },
  main_shutoff: {
    items: [
      'safety.electrical_gas.main_shutoff',
      'indoor.utility_laundry.main_shutoff',
      'outdoor.exterior_utilities.hose_bibbs',
    ],
    why:   'Labelling and access for the water shut-offs. The interior main and the exterior bibbs are one plumber’s labelling pass.',
  },
  exterior_lock: {
    items: ['safety.exterior_amenity.exterior_locks', 'outdoor.exterior_utilities.exterior_locks'],
    why:   'The same exterior locks and keypads, asked on both cadences. One locksmith or code-reset visit.',
  },
  pool_barrier: {
    items: ['safety.exterior_amenity.pool_barrier', 'outdoor.amenities.pool_barrier'],
    why:   'The same fence, gate and latch. A non-self-closing gate is one repair however it was noticed.',
  },
  firepit_clearance: {
    items: ['safety.exterior_amenity.firepit_clearance', 'outdoor.amenities.firepit'],
    why:   'Clearance between an open-flame feature and the structure. Repositioning is one job.',
  },
  smoke_detector_operational: {
    items: ['safety.fire.smoke_operational', 'indoor.bedrooms.smoke_detector'],
    why:   'A detector that does not respond to test. Asked quarterly on Indoor precisely so Safety’s annual cadence is not the only guard.',
  },
  co_detector_operational: {
    items: ['safety.fire.co_operational', 'indoor.bedrooms.co_detector'],
    why:   'Same as the smoke twin — a non-responding CO detector, caught on the faster cadence.',
  },
  hvac_filter: {
    items: ['safety.electrical_gas.hvac_filter', 'indoor.entry_interior.hvac'],
    why:   'The filter and airflow side of the HVAC system. DELIBERATELY NOT the same key as hvac_condenser — see that entry.',
  },
  water_heater_condition: {
    items: ['safety.water.no_active_leaks', 'indoor.utility_laundry.water_heater'],
    why:   'Moisture, corrosion and leakage at the water heater. Safety asks it among the leak checks, Indoor as part of the unit itself.',
  },
  washer_supply_lines: {
    items: ['safety.water.washer_supply_lines', 'indoor.utility_laundry.washer_supply_lines'],
    why:   'Rubber supply hoses behind the washer — one of the most common escape-of-water claims, so it is asked on both cadences.',
  },
  electrical_panel_clear: {
    items: ['safety.electrical_gas.panel_clear', 'indoor.utility_laundry.electrical_panel'],
    why:   'Panel access, labelling and exposed conductors. One electrician visit clears whichever form raised it.',
  },
  flooring_sound: {
    items: ['safety.structural.flooring', 'indoor.entry_interior.flooring'],
    why:   'Torn, loose or warped flooring. Safety frames it as a trip hazard and Indoor as condition; the repair is the same.',
  },
  egress_window: {
    items: ['safety.fire.egress_windows', 'indoor.entry_interior.egress_windows'],
    why:   'A bedroom egress window that will not open from inside. Life safety, so it is on the quarterly form as well as the annual one.',
  },
  home_water_filter: {
    items: ['indoor.kitchen.home_water_filter', 'outdoor.well.sediment_filter'],
    why:   'The whole-house filter cartridge. Indoor reaches it via the kitchen supply, Outdoor via the well system; one cartridge.',
  },

  // ── Same fault, multiple items WITHIN one form ────────────────────────────
  well_short_cycle: {
    items: ['outdoor.well.no_short_cycle', 'outdoor.well.pressure_tank', 'outdoor.well.check_valve'],
    why:   'A waterlogged bladder and a failed check valve produce THE SAME OBSERVABLE SYMPTOM — the pump restarting while a tap runs. A PM can see short-cycling but cannot reliably say which caused it, so all three are asked and one work order goes out however it was attributed. The plumber diagnoses; the inspector observes.',
  },
  under_sink_leak: {
    items: ['indoor.kitchen.under_sink', 'indoor.bathrooms.sinks_faucets'],
    why:   'Weeping supply lines and slow drains under a sink, asked once per room group. A plumber walks the property once.',
  },

  // ── Single-item: reserved names, no-ops for dedup today ───────────────────
  smoke_detector_present: {
    items: ['safety.fire.smoke_present'],
    why:   'A MISSING detector, distinct from one that fails its test — installing and replacing are different jobs. Reserved for a future form that asks the same.',
  },
  co_detector_present: {
    items: ['safety.fire.co_present'],
    why:   'The CO counterpart of smoke_detector_present, and separate from it: CO units are per-level, smoke units per-room.',
  },
  smoke_detector_age: {
    items: ['safety.fire.smoke_age'],
    why:   'End of service life at 10 years. Kept apart from _operational because an expired unit passes the button test and has still stopped sensing.',
  },
  co_detector_age: {
    items: ['safety.fire.co_age'],
    why:   'The CO counterpart, 7–10 years per manufacturer. Same reasoning as smoke_detector_age.',
  },
  chimney_swept: {
    items: ['safety.fire.chimney_swept'],
    why:   'Sweeping currency, distinct from Outdoor’s masonry and cap condition — a sweep and a mason are different trades.',
  },
  gas_appliance_safe: {
    items: ['safety.electrical_gas.gas_appliances'],
    why:   'Leak-check and venting across every gas appliance. Reserved; nothing else asks it today.',
  },
  sump_pump: {
    items: ['safety.water.sump_pump'],
    why:   'Pump operation, discharge and backup power. Reserved for a basement-focused form.',
  },
  pool_drain_vgb: {
    items: ['safety.exterior_amenity.pool_drain_vgb'],
    why:   'Anti-entrapment drain-cover compliance — a federal requirement, deliberately not folded into pool_barrier, which is the fence.',
  },
  grill_safe: {
    items: ['outdoor.amenities.grill'],
    why:   'The grill itself — grease, gas line, igniter, tank. NOT merged with firepit_clearance: Safety asks one combined clearance question about grills and fire pits, and an item can only carry one key, so clearance took it. Cleaning a grease tray is not repositioning a fire pit.',
  },
  entry_lock_operational: {
    items: ['indoor.entry_interior.entry_locks'],
    why:   'The main entry lock and latch alignment. Distinct from exterior_lock, which is every other exterior door and keypad.',
  },
  furniture_anchored: {
    items: ['indoor.entry_interior.anti_tip'],
    why:   'Anti-tip anchorage for tall furniture and wall-mounted TVs. Reserved.',
  },
  fridge_water_filter: {
    items: ['indoor.kitchen.fridge_water_filter'],
    why:   'The refrigerator’s own cartridge, deliberately not home_water_filter — different part, different shelf, different price.',
  },
  wifi_operational: {
    items: ['indoor.living_electronics.wifi'],
    why:   'Router and modem health plus advertised speed. Reserved.',
  },
  battery_sweep: {
    items: ['indoor.living_electronics.battery_sweep'],
    why:   'Low batteries across detectors, locks, thermostats and sensors — one sweep, one basket of cells.',
  },
  pest_activity: {
    items: ['indoor.utility_laundry.no_pests'],
    why:   'INTERIOR pest activity. Deliberately not exterior_pest: roaches in a cabinet and a wasp nest over a doorway are not one job.',
  },
  roof_condition: {
    items: ['outdoor.roof_drainage.roofing'],
    why:   'The roof covering itself, separate from gutters_clear. A roofer and a gutter clean are different visits.',
  },
  hvac_condenser: {
    items: ['outdoor.exterior_utilities.hvac_condenser'],
    why:   'The outdoor unit — vegetation clearance, level, guard. DELIBERATELY NOT hvac_filter: same asset, two visits, and merging them would hide one of two real work orders.',
  },
  exterior_pest: {
    items: ['outdoor.grounds.stinging_insects'],
    why:   'Stinging-insect nests at entries and eaves. See pest_activity for why this is a separate concern.',
  },
  well_pump_operation: {
    items: ['outdoor.well.pump_operation'],
    why:   'The pump reaching cut-out pressure without grinding — a hard failure, distinct from the short-cycling SYMPTOM that well_short_cycle merges.',
  },
}

/** Every concern_key actually carried by an item, across all three forms. */
export function concernKeysInUse(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const form of INSPECTION_FORMS) {
    for (const item of allItems(form)) {
      if (!item.concern_key) continue
      const list = out.get(item.concern_key) ?? []
      list.push(item.key)
      out.set(item.concern_key, list)
    }
  }
  return out
}
