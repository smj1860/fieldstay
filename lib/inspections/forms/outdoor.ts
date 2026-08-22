// lib/inspections/forms/outdoor.ts
//
// Outdoor Property & Grounds Inspection — docs/INSPECTIONS_SPEC.md §12.3.
// 45 top-level items plus a 9-item well section that only appears where the
// property has one. Quarterly or 2× a year.
//
// TWO SECTIONS HERE ARE CONDITIONAL, and the difference between them is the
// point of `na_asset_type`. The well section is gated on a `well_pump` asset —
// ledger-backed, so a municipal-water property never sees it and cannot be
// claimed to have skipped it. The HOA section is gated on `properties.hoa_name`
// being set. Neither is an inspector-asserted N/A.
//
// THE MOST USEFUL THING ON THIS FORM IS ALSO THE LEAST OBVIOUS: W3, W4 and W5
// share one `concern_key`. A waterlogged bladder and a failed check valve
// produce THE SAME OBSERVABLE SYMPTOM — the pump restarting while a tap runs —
// and a PM at a wellhead can reliably see short-cycling but cannot reliably say
// which component caused it. Asking all three and keying them together means
// the observation is recorded however the inspector attributes it, and one work
// order goes out for one fault rather than three for a guess.
//
// That is the general authoring rule worth carrying forward: ask for the
// SYMPTOM a non-expert can see, not the DIAGNOSIS only a trade can make.

import type { FormDefinition } from './types'

export const OUTDOOR_FORM: FormDefinition = {
  key:     'outdoor',
  name:    'Outdoor Property & Grounds Inspection',
  description:
    'Roof, drainage, grounds, decks, exterior utilities, well system, high-risk ' +
    'amenities and HOA standing. Records the weather at start, because a roof ' +
    'assessed under snow was not really assessed.',
  version: 1,
  sections: [
    // ── 1 ────────────────────────────────────────────────────────────────────
    {
      key:  'roof_drainage',
      name: 'Roof, Gutters & Drainage',
      items: [
        {
          key:    'outdoor.roof_drainage.roofing',
          prompt: 'Roofing — shingles/tiles intact, no sagging, loose flashing or storm damage',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'roofing', wo_priority: 'high',
          asset_type: 'roof', concern_key: 'roof_condition',
        },
        {
          key:    'outdoor.roof_drainage.gutters',
          prompt: 'Gutters and downspouts clear, secured, discharging away from the foundation',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'roofing',
          concern_key: 'gutters_clear',
        },
        {
          key:    'outdoor.roof_drainage.overhanging_branches',
          prompt: 'No branches overhanging the roofline, chimney or utility wires',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'landscaping',
        },
        {
          key:    'outdoor.roof_drainage.chimney',
          prompt: 'Chimney and flue — cap present, masonry intact, no cracks',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'roofing',
        },
        {
          key:    'outdoor.roof_drainage.siding_trim',
          prompt: 'Siding, trim and exterior paint sound — no rot, gaps or peeling',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'structural',
        },
        {
          key:    'outdoor.roof_drainage.foundation',
          prompt: 'Foundation — no new cracks, settling or water pooling against it',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'structural', wo_priority: 'high',
        },
        {
          key:    'outdoor.roof_drainage.windows_doors',
          prompt: 'Exterior windows and doors — seals intact, screens present, no storm damage',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'windows_doors',
        },
        {
          // Same vent as Indoor 42 and Safety 8, from the third vantage point —
          // exactly the case `concern_key` exists for: three legitimate
          // questions, one fault, one work order.
          key:    'outdoor.roof_drainage.dryer_vent_exit',
          prompt: 'Dryer vent exit point clear of lint and unobstructed',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'appliance', wo_priority: 'high',
          asset_type: 'dryer', concern_key: 'dryer_vent_clear',
        },
      ],
    },

    // ── 2 ────────────────────────────────────────────────────────────────────
    {
      key:  'grounds',
      name: 'Grounds, Walkways & Trip Hazards',
      items: [
        {
          // 9 and 10 share one key deliberately: the same trip-hazard concern
          // asked about two surfaces, and one uneven approach is one job.
          key:    'outdoor.grounds.driveway',
          prompt: 'Driveway and parking — level, no major cracks, potholes or oil slicks',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'landscaping',
          concern_key: 'walkway_trip_hazard',
        },
        {
          key:    'outdoor.grounds.walkways',
          prompt: 'Walkways and steps — pavers stable and level, path lighting installed',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'landscaping',
          concern_key: 'walkway_trip_hazard',
        },
        {
          key:    'outdoor.grounds.retaining_walls',
          prompt: 'Retaining walls and borders sound; drainage holes clear',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'landscaping',
        },
        {
          key:    'outdoor.grounds.landscaping',
          prompt: 'Lawn and landscaping mowed and trimmed; no burrows, roots or holes',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'landscaping',
        },
        {
          key:    'outdoor.grounds.stair_treads',
          prompt: 'Outdoor stair treads secure and slip-resistant',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'structural', wo_priority: 'high',
        },
        {
          key:    'outdoor.grounds.fencing',
          prompt: 'Perimeter fencing and gates sound, latching, no missing sections',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'landscaping',
        },
        {
          // Looks trivial and is not: it is what emergency services and a guest
          // arriving after dark both depend on.
          key:    'outdoor.grounds.house_numbers',
          prompt: 'House numbers visible from the road, day and night',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          // `exterior_pest`, deliberately NOT Indoor's `pest_activity`.
          key:    'outdoor.grounds.stinging_insects',
          prompt: 'No wasp, hornet or bee nests at entries, eaves or amenity areas',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'pest_control', wo_priority: 'high',
          concern_key: 'exterior_pest',
        },
        {
          key:    'outdoor.grounds.irrigation',
          prompt: 'Irrigation runs without leaks, broken heads or overspray onto walkways',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'landscaping',
        },
        {
          key:    'outdoor.grounds.mailbox',
          prompt: 'Mailbox and delivery area intact and accessible',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general',
        },
      ],
    },

    // ── 3 ────────────────────────────────────────────────────────────────────
    {
      key:  'decks',
      name: 'Decks, Balconies, Porches & Railings',
      items: [
        {
          key:    'outdoor.decks.decking',
          prompt: 'Decking — boards secure, no rot, loose fasteners, splinters or cupping',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'structural',
          asset_type: 'deck_structure',
        },
        {
          key:    'outdoor.decks.guardrails',
          prompt: 'Guardrails and handrails anchored, take weight, spindles < 4in apart',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'structural', wo_priority: 'urgent',
          asset_type: 'deck_structure', concern_key: 'deck_guardrail',
        },
        {
          key:    'outdoor.decks.under_deck',
          prompt: 'Under-deck area clear of combustibles, refuse and unmaintained storage',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general',
        },
        {
          // The N/A here is INSPECTOR-ASSERTED, not ledger-backed: most
          // properties have no waterfront and — unlike the pool — there is no
          // asset_type to check the claim against. Worth knowing when reading a
          // report, which is why the template says it out loud.
          key:    'outdoor.decks.waterfront',
          prompt: 'Dock, waterfront structure and moorings sound',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'structural',
          na_reason_template: 'No dock or waterfront structure at this property',
        },
      ],
    },

    // ── 4 ────────────────────────────────────────────────────────────────────
    {
      key:  'exterior_utilities',
      name: 'Exterior Utilities, Lighting & Perimeter',
      items: [
        {
          key:    'outdoor.exterior_utilities.lighting',
          prompt: 'Exterior lighting — motion, dusk-to-dawn and entry lights all functional',
          remediation: 'purchase_order', default_actions: ['replace'],
          concern_key: 'exterior_lighting',
        },
        {
          // `hvac_condenser`, NOT the `hvac_filter` Indoor 13 and Safety 19
          // share. Same asset, genuinely different jobs — a fouled condenser and
          // a due filter are two visits. Getting this one wrong would merge two
          // real work orders into one, which is the failure mode §5 warns about
          // when it says concern_key names a CONCERN rather than a thing.
          key:    'outdoor.exterior_utilities.hvac_condenser',
          prompt: 'HVAC / heat-pump condenser clear of vegetation, level, guard intact',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'hvac',
          asset_type: 'hvac', concern_key: 'hvac_condenser',
        },
        {
          key:    'outdoor.exterior_utilities.hose_bibbs',
          prompt: 'Hose bibbs and exterior shut-offs accessible, marked, no drips',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'plumbing',
          asset_type: 'plumbing_system', concern_key: 'main_shutoff',
        },
        {
          key:    'outdoor.exterior_utilities.exterior_outlets',
          prompt: 'Exterior outlets have weatherproof covers and GFCI protection',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'high',
          asset_type: 'electrical_panel', concern_key: 'gfci_wet_areas',
        },
        {
          // Deliberately NOT the same concern as Indoor 47 (the indoor bins).
          key:    'outdoor.exterior_utilities.trash_enclosure',
          prompt: 'Trash and recycling enclosures secure and animal-proof',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          key:    'outdoor.exterior_utilities.exterior_locks',
          prompt: 'Exterior deadbolts, smart locks and keypads secure; codes tested',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general', wo_priority: 'high',
          asset_type: 'smart_lock', concern_key: 'exterior_lock',
        },
        {
          key:    'outdoor.exterior_utilities.cameras',
          prompt: 'Exterior cameras and doorbell — powered, reporting, sited only outdoors',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'other',
        },
        {
          key:    'outdoor.exterior_utilities.freeze_protection',
          prompt: 'Freeze protection in place seasonally — bibbs covered, lines drained',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'plumbing',
        },
        {
          key:    'outdoor.exterior_utilities.septic',
          prompt: 'Septic access clear, marked, no surfacing or odour',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'plumbing', wo_priority: 'high',
          asset_type: 'septic_system', na_asset_type: 'septic_system',
        },
        {
          key:    'outdoor.exterior_utilities.snow_equipment',
          prompt: 'Snow and ice equipment staged and serviceable (seasonal)',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
      ],
    },

    // ── 4a ───────────────────────────────────────────────────────────────────
    {
      // Ledger-gated: municipal-water properties never see this section, and
      // the skip is backed by the asset ledger rather than asserted.
      key:  'well',
      name: 'Well & Water System',
      shown_when_asset: 'well_pump',
      items: [
        {
          key:    'outdoor.well.wellhead',
          prompt: 'Wellhead cap sealed, casing above grade, no surface water pooling at the head',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'plumbing', wo_priority: 'high',
          asset_type: 'well_pump',
        },
        {
          key:    'outdoor.well.pump_operation',
          prompt: 'Pump runs and reaches cut-out pressure; no grinding or overheating',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'plumbing', wo_priority: 'high',
          asset_type: 'well_pump', concern_key: 'well_pump_operation',
        },
        {
          // W3/W4/W5 share `well_short_cycle` — see the file header.
          key:    'outdoor.well.no_short_cycle',
          prompt: 'Pump does NOT short-cycle when a tap is run',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'plumbing',
          asset_type: 'well_pump', concern_key: 'well_short_cycle',
        },
        {
          key:    'outdoor.well.pressure_tank',
          prompt: 'Pressure tank holds its air charge; bladder not waterlogged',
          remediation: 'purchase_order', default_actions: ['replace'],
          asset_type: 'well_pump', concern_key: 'well_short_cycle',
        },
        {
          key:    'outdoor.well.check_valve',
          prompt: 'Check valve holding — system keeps pressure with the pump off',
          remediation: 'purchase_order', default_actions: ['replace'],
          asset_type: 'well_pump', concern_key: 'well_short_cycle',
        },
        {
          key:    'outdoor.well.pressure_switch',
          prompt: 'Pressure switch cutting in and out at its rated range (e.g. 40/60 psi)',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'plumbing',
          asset_type: 'well_pump',
        },
        {
          key:    'outdoor.well.sediment_filter',
          prompt: 'Sediment/whole-house filter within its service life',
          remediation: 'purchase_order', default_actions: ['replace'],
          concern_key: 'home_water_filter',
        },
        {
          // Notify for the same reason the permit items are: an out-of-date
          // water test is a lab appointment, not a dispatch.
          key:    'outdoor.well.potability_test',
          prompt: 'Water potability test current (coliform, within 12 months)',
          remediation: 'notify', default_actions: [],
        },
        {
          key:    'outdoor.well.tap_quality',
          prompt: 'No sediment, discolouration, odour or air spitting at the taps',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'plumbing',
          asset_type: 'well_pump',
        },
      ],
    },

    // ── 5 ────────────────────────────────────────────────────────────────────
    {
      // The section where skipping is most tempting and least acceptable, which
      // is why five of its nine items carry `na_asset_type`.
      key:  'amenities',
      name: 'High-Risk Amenities',
      items: [
        {
          key:    'outdoor.amenities.pool_barrier',
          prompt: 'Pool/spa barrier meets code height; gates self-close and self-latch',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'pool', wo_priority: 'urgent',
          asset_type: 'hot_tub', na_asset_type: 'hot_tub',
          concern_key: 'pool_barrier',
        },
        {
          key:    'outdoor.amenities.pool_water',
          prompt: 'Pool/spa cover secure; water clear; pump and filter operating',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'pool',
          asset_type: 'pool_pump', na_asset_type: 'pool_pump',
        },
        {
          key:    'outdoor.amenities.firepit',
          prompt: 'Fire pit and outdoor heating 10+ ft from structures; media level',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general', wo_priority: 'high',
          concern_key: 'firepit_clearance',
        },
        {
          key:    'outdoor.amenities.grill',
          prompt: 'Grill — grease tray clean, gas line leak-tested, igniter works, tank secured',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general', wo_priority: 'high',
          concern_key: 'grill_safe',
        },
        {
          key:    'outdoor.amenities.propane',
          prompt: 'Propane tank level adequate, or a full spare on site',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          key:    'outdoor.amenities.furniture',
          prompt: 'Outdoor furniture sound — no rust-through or sharp edges, cushions clean',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          // Outdoor's counterpart to Safety 36: that item records whether the
          // equipment EXISTS (a coverage question); this asks whether it is
          // SOUND (a condition question). Two different facts about one object.
          key:    'outdoor.amenities.play_equipment',
          prompt: 'Playground, swing set or trampoline sound and anchored',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'structural', wo_priority: 'high',
          na_reason_template: 'No playground, swing set or trampoline at this property',
        },
        {
          key:    'outdoor.amenities.generator',
          prompt: 'Generator — starts, fuel adequate, exhaust clear of the structure',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'electrical',
          asset_type: 'generator', na_asset_type: 'generator',
        },
        {
          key:    'outdoor.amenities.solar',
          prompt: 'Solar array — panels unshaded and intact, inverter reporting',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'electrical',
          asset_type: 'solar_system', na_asset_type: 'solar_system',
        },
      ],
    },

    // ── 6 ────────────────────────────────────────────────────────────────────
    {
      // The one place the "a No creates a WO or PO" rule does not hold, stated
      // rather than bent. Unpaid dues are a payment; missing bylaws are a
      // document to obtain. Forcing either through the maintenance board would
      // put a finance task on a vendor's queue.
      key:  'hoa',
      name: 'HOA Rules & Standing',
      shown_when_property_field: 'hoa_name',
      items: [
        {
          key:    'outdoor.hoa.documents',
          prompt: 'Current copies of the bylaws, policies and rules on file',
          remediation: 'notify', default_actions: [],
        },
        {
          // Notify, but the Repair/Service/Replace chips stay AVAILABLE: a
          // compliance failure usually does have a physical remedy — the lawn,
          // the fence, a trailer parked where it should not be. Nothing is
          // pre-ticked because which one applies is entirely situational, and
          // the DB CHECK forbids a pre-tick on a notify item anyway.
          key:    'outdoor.hoa.compliance',
          prompt: 'Property in compliance with all HOA rules and regulations',
          remediation: 'notify', default_actions: [],
        },
        {
          // Deliberately notify-only. There is no version of "dispatch someone"
          // that is the right answer to unpaid dues.
          key:    'outdoor.hoa.dues',
          prompt: 'HOA dues and assessments current',
          remediation: 'notify', default_actions: [],
        },
      ],
    },

    // ── 7 ────────────────────────────────────────────────────────────────────
    {
      key:  'assets',
      name: 'Property Assets',
      items: [
        {
          key:    'outdoor.assets.condition',
          prompt: 'Operational, no visible damage, no unusual noise or smell',
          repeat_per_asset: true,
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general',
          children: [{
            key:    'outdoor.assets.plate_photo',
            prompt: 'Serial/model plate photo',
            response_type: 'photo', photo_required: true,
            remediation: 'none', default_actions: [],
          }],
        },
      ],
    },

    // ── Sign-off ─────────────────────────────────────────────────────────────
    {
      key:  'signoff',
      name: 'Sign-off',
      items: [
        {
          // Pressure-washing, gutter clearing and grounds cleanup all land here.
          key:    'outdoor.signoff.additional_cleaning',
          prompt: 'Does additional cleaning need to be scheduled?',
          remediation: 'none', default_actions: [],
          children: [{
            // No `show_when`, for the reason spelled out on Indoor's twin.
            key:    'outdoor.signoff.cleaning_detail',
            prompt: 'What needs cleaning',
            response_type: 'text', is_required: false,
            remediation: 'none', default_actions: [],
          }],
        },
        {
          key:    'outdoor.signoff.certification',
          prompt: 'Certification — inspection completed on-site; all exceptions recorded with photos',
          remediation: 'none', default_actions: [],
        },
        {
          key:    'outdoor.signoff.signature',
          prompt: 'Inspector signature',
          response_type: 'photo', photo_required: true,
          remediation: 'none', default_actions: [],
        },
      ],
    },
  ],
}
