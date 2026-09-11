// lib/inspections/forms/safety.ts
//
// Property Safety & Risk Mitigation Inspection — docs/INSPECTIONS_SPEC.md §12.1.
// 54 top-level items across 7 sections. Runs 1× or 2× a year.
//
// Items added out of the spec's original sequence carry a LETTERED SUFFIX
// rather than renumbering everything after them — same convention as Indoor's
// 14a/19a. 17a (gas line integrity) was the first, on 2026-08-30. The
// ordinance-readiness pass on 2026-09-11 added 3b, 7f, 11a, 13a, 17b, 37a,
// 38a, 40a and 40b, plus 7e inside the extinguisher repeat group. See
// CONCERN_KEY_MAP in ./index.ts and EXPECTED_ROOT_ITEM_COUNTS for the other
// two places such an addition has to be reflected.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE 2026-09-11 PASS WAS FOR
//
// §1 calls this form insurance evidence. It is also, in practice, the only
// artifact a PM has when a city asks them to demonstrate a property is fit to
// be licensed — and read against the ordinances that actually govern that
// (IRC/NFPA-derived municipal STR codes), the form was passing properties that
// would fail a pre-licensing inspection. Not because it asked the wrong
// questions, but because it asked the right ones at the wrong SCOPE: alarms in
// bedrooms rather than on every level; extinguishers described per unit with
// nothing asking whether the set covers the building; a diagram posted with
// nothing saying what is on it; "guardrails sound" with neither the 30in
// trigger nor the 36in height that decide whether one is required at all.
//
// Every addition in that pass is a requirement a municipal inspector can cite,
// not a best practice. Where the requirement is conditional (bars on windows,
// a gas detector, an LP appliance) the item renders everywhere and is answered
// N/A — never gated — because the walk before the permit inspection is
// precisely the one that must not be silent about it.
//
// This is the form §1 calls insurance evidence, and the one whose findings an
// insurer is most likely to read. Two consequences visible in the data below:
// items 3 and 6 ask a detector's AGE rather than only whether it beeps (an
// expired unit beeps perfectly well and has stopped sensing), and item 34 asks
// about VGB drain-cover compliance, which is federal law since 2008 and a named
// exclusion in many policies.
//
// NOTE ON WHAT THIS FORM DOES NOT HAVE: no cleaning checkbox. Safety is about
// hazards, not cleanliness, and it runs once or twice a year — so there is no
// per-item Cleaning flag and therefore no cleaning roll-up at sign-off.
//
// It DOES now have a sign-off. The gap was flagged during phase 2 and closed
// on 2026-08-22 with the declaration @smj1860 supplied — it had been intended
// for this form all along and was missing from §12.1's tables rather than from
// the product's intent.

import type { FormDefinition } from './types'

export const SAFETY_FORM: FormDefinition = {
  key:     'safety',
  name:    'Property Safety & Risk Mitigation Inspection',
  description:
    'Life-safety systems, utilities, structure, water and amenity risk controls. ' +
    'Performed once or twice a year and retained as the evidentiary record of the ' +
    "property's safety posture.",
  version: 3,
  sections: [
    // ── 1 ────────────────────────────────────────────────────────────────────
    {
      key:  'fire',
      name: 'Fire Safety & Life Safety Systems',
      items: [
        {
          key:    'safety.fire.smoke_present',
          prompt: 'Smoke alarms in every bedroom, in the hallway outside each sleeping area, and on every level including basement and habitable attic',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'urgent',
          concern_key: 'smoke_detector_present',
          children: [{
            key:    'safety.fire.smoke_present_where',
            prompt: 'Which room or level needs a smoke alarm?',
            response_type: 'text', show_when: 'fail',
            remediation: 'none', default_actions: [],
          }],
        },
        {
          key:    'safety.fire.smoke_operational',
          prompt: 'Smoke detectors tested and operational',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'urgent',
          concern_key: 'smoke_detector_operational',
          children: [{
            key:    'safety.fire.smoke_operational_where',
            prompt: "Which room's detector failed the test?",
            response_type: 'text', show_when: 'fail',
            remediation: 'none', default_actions: [],
          }],
        },
        {
          key:    'safety.fire.smoke_age',
          prompt: 'Smoke detectors within their 10-year service life (date is on the back)',
          remediation: 'purchase_order', default_actions: ['replace'],
          wo_priority: 'high',
          concern_key: 'smoke_detector_age',
          children: [{
            key:    'safety.fire.smoke_age_which',
            prompt: 'Which detectors are expired, and their manufacture dates',
            response_type: 'text', show_when: 'fail',
            remediation: 'none', default_actions: [],
          }],
        },
        {
          // 3b. THE ITEM A PERMIT INSPECTOR CHECKS AND THIS FORM COULD NOT SEE.
          //
          // 1, 2 and 3 ask whether alarms are present, responding and in date —
          // three true things a property can be while still failing its
          // pre-licensing inspection, because most current ordinances also
          // specify WHAT KIND of alarm and that they are interconnected. An
          // interconnected set is the difference between a basement fire waking
          // the upstairs bedrooms and not, which is why the codes moved.
          //
          // A work order rather than a purchase order even though the usual fix
          // is bought rather than repaired: wireless-interconnect alarms are a
          // retrofit somebody has to install and pair, and battery-only units
          // in a jurisdiction that requires hardwiring are an electrician's
          // visit. The inspector can add the Replace chip where the fix really
          // is just a box of alarms.
          key:    'safety.fire.smoke_interconnected',
          prompt: 'Smoke alarms are hardwired or 10-year sealed-battery units, and interconnected so one sounding sounds them all',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'high',
          concern_key: 'smoke_detector_interconnect',
        },
        {
          key:    'safety.fire.co_present',
          prompt: 'CO alarms on every level and within 10 ft of each sleeping area — required wherever there is a fuel-burning appliance, fireplace or attached garage',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'urgent',
          concern_key: 'co_detector_present',
          children: [{
            key:    'safety.fire.co_present_where',
            prompt: 'Which level needs a CO detector?',
            response_type: 'text', show_when: 'fail',
            remediation: 'none', default_actions: [],
          }],
        },
        {
          key:    'safety.fire.co_operational',
          prompt: 'CO detectors operational',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'urgent',
          concern_key: 'co_detector_operational',
          children: [{
            key:    'safety.fire.co_operational_where',
            prompt: "Which level's detector failed the test?",
            response_type: 'text', show_when: 'fail',
            remediation: 'none', default_actions: [],
          }],
        },
        {
          key:    'safety.fire.co_age',
          prompt: 'CO detectors within their service life (7–10 yr, per manufacturer)',
          remediation: 'purchase_order', default_actions: ['replace'],
          wo_priority: 'high',
          concern_key: 'co_detector_age',
        },
        {
          // The count itself never fails — it sizes the repeat group below it.
          key:    'safety.fire.extinguisher_count',
          prompt: 'Number of fire extinguishers',
          response_type: 'count',
          remediation: 'none', default_actions: [],
          repeats: [
            {
              key:    'safety.fire.extinguisher_location',
              prompt: 'Location',
              response_type: 'text',
              remediation: 'none', default_actions: [],
            },
            {
              // The RATING, asked per unit because it is printed per unit. A
              // kitchen-sized BC aerosol can and a 5 lb ABC extinguisher both
              // answer "yes" to charged and in date, and only one of them is
              // the multi-purpose unit an ordinance names.
              key:    'safety.fire.extinguisher_rating',
              prompt: 'Rated 2-A:10-B:C or better (printed on the label)',
              remediation: 'purchase_order', default_actions: ['replace'],
            },
            {
              key:    'safety.fire.extinguisher_charged',
              prompt: 'Fully charged',
              remediation: 'purchase_order', default_actions: ['replace'],
              wo_priority: 'high',
            },
            {
              key:    'safety.fire.extinguisher_expiry',
              prompt: 'Expiration date',
              response_type: 'date',
              remediation: 'purchase_order', default_actions: ['replace'],
            },
            {
              // The one place a PASSING item still produces evidence: an
              // extinguisher tag is photographed every time, because the tag IS
              // the record and a claim about it is worth less than the picture.
              key:    'safety.fire.extinguisher_tag_photo',
              prompt: 'Tag photo',
              response_type: 'photo', photo_required: true,
              remediation: 'none', default_actions: [],
            },
          ],
        },
        {
          // 7f. WHAT THE REPEAT GROUP CANNOT ASK.
          //
          // 7a–7e describe each extinguisher that exists. Nothing reads those
          // rows and decides whether the SET of them covers the building — 7a
          // is free text, so three good extinguishers in one garage pass every
          // per-unit question and fail the ordinance. This is the one question
          // about the arrangement rather than the equipment, and it is asked of
          // the inspector because they are the one standing in the building.
          key:    'safety.fire.extinguisher_coverage',
          prompt: 'At least one extinguisher on every floor, one within 30 ft of the kitchen, each mounted visible and unobstructed',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general', wo_priority: 'high',
        },
        {
          key:    'safety.fire.dryer_vent',
          prompt: 'Dryer lint trap and vent run clear to the exterior',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'appliance', wo_priority: 'high',
          asset_type: 'dryer',
          per_unit: true, concern_key: 'dryer_vent_clear',
        },
        {
          key:    'safety.fire.chimney_swept',
          prompt: 'Chimney/flue swept within the last 12 months; firebox and damper sound',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general',
          concern_key: 'chimney_swept',
        },
        {
          key:    'safety.fire.exits_clear',
          prompt: 'Exit doors and pathways clear and fully operational',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'windows_doors', wo_priority: 'urgent',
          children: [{
            key:    'safety.fire.exit_photos',
            prompt: 'Photo of each exit',
            response_type: 'photo', show_when: 'fail',
            remediation: 'none', default_actions: [],
          }],
        },
        {
          key:    'safety.fire.egress_windows',
          prompt: 'Bedroom egress windows open fully from inside without a tool',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'windows_doors', wo_priority: 'urgent',
          concern_key: 'egress_window',
        },
        {
          // 11a. The second half of egress, and rare enough to be forgotten:
          // 11 asks whether the window opens, this asks whether anything BOLTED
          // OVER IT does. Bars, grilles and fixed insect screens are all common
          // on ground-floor and lakefront properties, and a release needing a
          // key or a screwdriver fails every ordinance that mentions them —
          // the guest is asleep and the room is full of smoke.
          //
          // Most properties have none; it is answered N/A with a reason, the
          // same as any other item whose subject is absent.
          key:    'safety.fire.window_bars_release',
          prompt: 'Security bars, grilles or fixed screens on bedroom windows release from inside without a key, tool or special knowledge',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'windows_doors', wo_priority: 'urgent',
        },
        {
          key:    'safety.fire.emergency_lighting',
          prompt: 'Emergency lighting / flashlights present and functional',
          remediation: 'purchase_order', default_actions: ['replace'],
          children: [{
            key:    'safety.fire.emergency_lighting_location',
            prompt: 'Location',
            response_type: 'text', show_when: 'fail',
            remediation: 'none', default_actions: [],
          }],
        },
        {
          // The prompt names the CONTENTS because that is what a posted-map
          // ordinance actually specifies, and because "a plan is posted" passed
          // for a fire-escape sticker with no floor layout on it. The property
          // ADDRESS belongs on it for a reason worth stating: a guest calling
          // 911 from a house they arrived at in the dark frequently cannot say
          // where they are.
          key:    'safety.fire.evacuation_plan',
          prompt: 'Evacuation diagram posted at the main exit — floor layout, exit routes, extinguisher and first-aid locations, the property address, and emergency contacts',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          // 13a. The diagram above points at this. An inspection that verifies
          // the map and never verifies what the map promises is checking the
          // paperwork rather than the property.
          key:    'safety.fire.first_aid_kit',
          prompt: 'First-aid kit stocked, in date, and where the posted diagram says it is',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
      ],
    },

    // ── 2 ────────────────────────────────────────────────────────────────────
    {
      key:  'electrical_gas',
      name: 'Electrical, Gas & Utility Safety',
      items: [
        {
          key:    'safety.electrical_gas.gfci',
          prompt: 'GFCI outlets installed and functional in all wet areas',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'high',
          asset_type: 'electrical_panel', concern_key: 'gfci_wet_areas',
        },
        {
          key:    'safety.electrical_gas.panel_clear',
          prompt: 'Electrical panel unobstructed, no exposed wiring, no tripped breakers',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'high',
          asset_type: 'electrical_panel',
          per_unit: true, concern_key: 'electrical_panel_clear',
        },
        {
          key:    'safety.electrical_gas.no_daisy_chain',
          prompt: 'No daisy-chained power strips, no extension cords in permanent use',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          key:    'safety.electrical_gas.gas_appliances',
          prompt: 'Gas appliances — furnace, water heater, range — leak-checked, vented, no odour',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general', wo_priority: 'urgent',
          concern_key: 'gas_appliance_safe',
        },
        {
          // Item 17a — the line itself, not the appliances hanging off it.
          // 17 catches a leaking appliance; this catches the corroded or
          // damaged run feeding it (and the meter/shut-off) before it ever
          // reaches one. Same urgency class as 17 for the same reason: a gas
          // risk is life-safety, not maintenance.
          key:    'safety.electrical_gas.gas_line_integrity',
          prompt: 'Gas supply line intact — no corrosion, damage, or exposed fittings; shut-off valve accessible and labelled',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general', wo_priority: 'urgent',
          concern_key: 'gas_line_integrity',
        },
        {
          // 17b. 17 asks whether the appliances leak and 17a whether the line
          // feeding them is sound. Neither asks whether anything would NOTICE
          // a leak between two annual walks — the same gap the water section
          // closed with its sensor and shut-off pair (26 and 27).
          //
          // THE MOUNTING HEIGHT IS IN THE PROMPT ON PURPOSE. Propane is heavier
          // than air and pools at the floor; natural gas rises. A detector at
          // the wrong height is installed, powered, tested and useless, and it
          // is the single most common way this gets done wrong.
          //
          // Answered N/A at an all-electric property. Deliberately NOT gated on
          // a property fact: a fact captured on completion only takes effect on
          // the NEXT walk, so gating it would make the first walk at every
          // property silent about gas detection — the walk most likely to be
          // the one before a permit inspection.
          key:    'safety.electrical_gas.gas_detector',
          prompt: 'Combustible-gas detector fitted near each fuel-burning appliance — mounted low for propane, high for natural gas',
          remediation: 'purchase_order', default_actions: ['replace'],
          wo_priority: 'high',
          concern_key: 'gas_detector',
        },
        {
          key:    'safety.electrical_gas.main_shutoff',
          prompt: 'Main water shut-off labelled, accessible, valve tool in place',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'plumbing',
          asset_type: 'plumbing_system', concern_key: 'main_shutoff',
        },
        {
          key:    'safety.electrical_gas.hvac_filter',
          prompt: 'HVAC air filters clean, supply vents unblocked, service log current',
          remediation: 'purchase_order', default_actions: ['replace'],
          asset_type: 'hvac',
          per_unit: true, concern_key: 'hvac_filter',
        },
      ],
    },

    // ── 3 ────────────────────────────────────────────────────────────────────
    {
      key:  'structural',
      name: 'Structural, Floor & Slip/Trip Hazard Mitigation',
      items: [
        {
          key:    'safety.structural.handrails',
          prompt: 'Handrail on every flight of four or more risers — graspable, secure, full length; treads slip-resistant and clear',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'structural', wo_priority: 'high',
          concern_key: 'handrail_secure',
        },
        {
          key:    'safety.structural.walkways',
          prompt: 'Walkways and driveways level, clear of trip hazards, algae, ice',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'landscaping',
          concern_key: 'walkway_trip_hazard',
        },
        {
          key:    'safety.structural.flooring',
          prompt: 'Flooring sound — no torn carpet, loose tile or warped boards',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'flooring',
          concern_key: 'flooring_sound',
        },
        {
          key:    'safety.structural.deck_guardrail',
          prompt: 'Guardrails wherever a walking surface sits more than 30in above grade — at least 36in high, spindles under 4in apart, posts and ledger secure',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'structural', wo_priority: 'urgent',
          asset_type: 'deck_structure',
          per_unit: true, concern_key: 'deck_guardrail',
        },
      ],
    },

    // ── 4 ────────────────────────────────────────────────────────────────────
    {
      key:  'water',
      name: 'Water Leak & Freeze Damage Prevention',
      items: [
        {
          key:    'safety.water.no_active_leaks',
          prompt: 'No active leaks under sinks, behind toilets, around the water heater',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'plumbing', wo_priority: 'high',
          asset_type: 'water_heater', concern_key: 'water_heater_condition',
        },
        {
          key:    'safety.water.washer_supply_lines',
          prompt: 'Braided stainless washing-machine supply lines fitted (not rubber)',
          remediation: 'purchase_order', default_actions: ['replace'],
          asset_type: 'washer',
          per_unit: true, concern_key: 'washer_supply_lines',
        },
        {
          key:    'safety.water.leak_sensors',
          prompt: 'Leak sensors installed at water heater, sump pump, washing machine',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          // §12.1: on this form because an automatic shut-off is a device
          // insurers actively discount for. Item 26 asks whether a sensor would
          // NOTICE a leak; this asks whether anything ACTS on it.
          key:    'safety.water.auto_shutoff',
          prompt: 'Automatic water shut-off device fitted and in service',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          key:    'safety.water.sump_pump',
          prompt: 'Sump pump runs when tested; discharge clear; backup power present',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'plumbing',
          concern_key: 'sump_pump',
        },
        {
          key:    'safety.water.gutters',
          prompt: 'Gutters and downspouts clear, draining away from the foundation',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'roofing',
          concern_key: 'gutters_clear',
        },
      ],
    },

    // ── 5 ────────────────────────────────────────────────────────────────────
    {
      key:  'exterior_amenity',
      name: 'Exterior, Amenity & Security Risk Controls',
      items: [
        {
          key:    'safety.exterior_amenity.exterior_lighting',
          prompt: 'Exterior lighting functional at every entryway',
          remediation: 'purchase_order', default_actions: ['replace'],
          concern_key: 'exterior_lighting',
        },
        {
          key:    'safety.exterior_amenity.firepit_clearance',
          prompt: 'Grills and fire pits at safe distance from structures; gas shut-offs marked',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general', wo_priority: 'high',
          concern_key: 'firepit_clearance',
        },
        {
          key:    'safety.exterior_amenity.no_flame_on_deck',
          prompt: 'No grill or open flame in use on a deck, balcony or under an overhang',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general', wo_priority: 'high',
        },
        {
          key:    'safety.exterior_amenity.pool_barrier',
          prompt: 'Pool / hot tub fencing, self-closing gates and safety covers latch securely',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'pool', wo_priority: 'urgent',
          asset_type: 'hot_tub', na_asset_type: 'hot_tub',
          concern_key: 'pool_barrier',
        },
        {
          // Virginia Graeme Baker Act — federal law since 2008, failure mode is
          // a fatality, and a named exclusion in many policies. The form checked
          // the fence and the gate and never looked at the drain.
          key:    'safety.exterior_amenity.pool_drain_vgb',
          prompt: 'Pool/spa drain covers VGB-compliant and undamaged; anti-entrapment in place',
          remediation: 'purchase_order', default_actions: ['replace'],
          wo_priority: 'urgent',
          asset_type: 'pool_pump',
          per_unit: true, na_asset_type: 'pool_pump',
          concern_key: 'pool_drain_vgb',
        },
        {
          key:    'safety.exterior_amenity.hot_tub_temp',
          prompt: 'Hot tub thermostat limited to 104°F or below',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'pool', wo_priority: 'high',
          asset_type: 'hot_tub',
          per_unit: true, na_asset_type: 'hot_tub',
        },
        {
          // THE ONE ITEM ON ANY FORM WHOSE FAILING ANSWER IS `yes`, and
          // deliberately not phrased around a failure at all. A trampoline is
          // frequently a policy EXCLUSION rather than a hazard rating — the
          // answer changes coverage regardless of the equipment's condition, so
          // what matters is that the record states it plainly. Outdoor 39 asks
          // separately whether it is sound. Registered as the sole exception in
          // the seed test's "a No is the failure" rule.
          key:    'safety.exterior_amenity.high_risk_equipment_present',
          prompt: 'Trampoline, playground or diving board present at this property',
          remediation: 'none', default_actions: [],
        },
        {
          key:    'safety.exterior_amenity.exterior_locks',
          prompt: 'Exterior deadbolts and smart locks secure; keyless codes tested',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general', wo_priority: 'high',
          asset_type: 'smart_lock',
          per_unit: true, concern_key: 'exterior_lock',
        },
        {
          // 37a. ALREADY ASKED ON OUTDOOR, AND THAT WAS THE PROBLEM.
          //
          // Outdoor is a per-property opt-in scheduled as ordinary recurring
          // maintenance; Safety is the only form that runs at EVERY property
          // (see lib/inspections/safety-template.ts). So an ordinance-mandated
          // item living only on Outdoor is asked at the properties somebody
          // remembered to schedule an Outdoor walk for. Anything a permit
          // depends on belongs here, and shares a concern_key with its Outdoor
          // twin so the two askings are one job.
          key:    'safety.exterior_amenity.address_numbers',
          prompt: 'House numbers legible from the street day and night — at least 4in high, contrasting with their background',
          remediation: 'purchase_order', default_actions: ['replace'],
          concern_key: 'address_visible',
        },
        {
          // ASKED ONCE, THEN IT DROPS OFF. `asks_property_fact` renders this
          // only while properties.has_security_system is NULL, and completion
          // writes the answer — so every property is asked on its first Safety
          // walk and none is asked twice.
          //
          // Record-only, like high_risk_equipment_present: "No" is not a
          // failure. Most short-term rentals have no alarm, and an item that
          // treated their absence as a fault would fill the owner portal with
          // findings nobody intends to act on and make the pass count a lie.
          //
          // NOT registered in INVERTED_POLARITY_ITEMS, and that is not an
          // oversight: that set exempts prompts the PROMPT-WORDING regex
          // catches (an is/does/any lead plus a problem word), and this prompt
          // does not trip it. Registering it there would imply the check had
          // something to say about it. The polarity concern here is about the
          // ANSWER — Pass means present — and is handled where answers are
          // read, not where prompts are worded.
          key:    'safety.exterior_amenity.security_system_present',
          prompt: 'Monitored alarm or security system present at this property',
          remediation: 'none', default_actions: [],
          asks_property_fact: 'has_security_system',
        },
        {
          // AND THIS ONE DOES NOT DROP OFF, which is the half worth arguing.
          //
          // Presence is a fact about the building and changes rarely. A
          // monitoring CONTRACT lapses constantly — an unpaid renewal leaves
          // the panel on the wall, the keypad lighting up, and nobody being
          // called. That is the failure this item exists to catch, and catching
          // it needs asking every year at the properties that have one.
          //
          // So the capture question is annual-once and the condition question
          // is annual-always. A form that dropped both would leave every year
          // after the first silent about the alarm, and §1's argument is that
          // the multi-year record IS the artifact.
          key:    'safety.exterior_amenity.security_system_service',
          prompt: 'Alarm arms and disarms, sensors respond, monitoring contract current',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general',
          shown_when_property_fact: 'has_security_system',
          concern_key: 'security_system',
        },
      ],
    },

    // ── 6 ────────────────────────────────────────────────────────────────────
    {
      // Every item here is 'notify'. A lapsed permit is neither a work order nor
      // a purchase order, and pushing one onto the maintenance board would put a
      // finance task on a vendor's queue. Before `notify` existed these were
      // unexpressible, which is why an insurance-evidence artifact had nothing
      // to say about whether the property was legally permitted to operate.
      key:  'permits',
      name: 'Permits, Documents & Standing',
      items: [
        {
          key:    'safety.permits.str_permit',
          prompt: 'Short-term rental permit or licence current for this jurisdiction',
          remediation: 'notify', default_actions: [],
        },
        {
          // 38a. Holding a permit and DISPLAYING it are separately enforceable,
          // and the listing half is the one that gets cited: most ordinances
          // that require a permit number in the advertisement check it from a
          // desk, on the platform, without visiting the property at all.
          key:    'safety.permits.permit_number_displayed',
          prompt: 'Permit or licence number displayed as the ordinance requires — posted inside and shown in every listing',
          remediation: 'notify', default_actions: [],
        },
        {
          // The second clause matters more than the first: a standard
          // homeowner's policy that excludes short-term rental use is worse
          // than no policy, because the owner believes they are covered.
          key:    'safety.permits.liability_insurance',
          prompt: 'Liability insurance certificate current and covering short-term rental use',
          remediation: 'notify', default_actions: [],
        },
        {
          key:    'safety.permits.occupancy_limit',
          prompt: 'Occupancy limit posted with the permit information, and consistent with both the listing and the permit',
          remediation: 'notify', default_actions: [],
        },
        {
          // 40a. Not life safety, and on the form anyway: these are PERMIT
          // CONDITIONS in most jurisdictions that license short-term rentals,
          // and a renewal denied over an unposted trash schedule costs the
          // owner the season just as surely as a failed alarm test.
          key:    'safety.permits.house_rules_posted',
          prompt: 'Quiet hours, trash and recycling schedule, and parking limits posted as the permit conditions require',
          remediation: 'notify', default_actions: [],
        },
        {
          // 40b. The single most common non-structural revocation trigger: the
          // ordinance requires a named local party reachable within a stated
          // number of minutes, the PM changes phone number or the contact moves
          // away, and nobody tells the county until a neighbour complains and
          // the number rings out.
          key:    'safety.permits.local_contact',
          prompt: 'Local responsible party and 24-hour contact number current with the jurisdiction, and posted for guests and neighbours',
          remediation: 'notify', default_actions: [],
        },
      ],
    },

    // ── Sign-off ─────────────────────────────────────────────────────────────
    // DELIBERATELY NOT the shared signoffSection() the other two forms use.
    // Safety has no cleaning checkbox anywhere on it, so it has no cleaning
    // roll-up to sign off — and its declaration is a specific, stronger
    // attestation than Indoor/Outdoor's generic certification line, because
    // this is the form §1 calls insurance evidence and the one an adjuster is
    // most likely to actually read.
    //
    // Two items, not four. The paper form's sign-off block also carries a DATE
    // and an "Attached Documentation: Photo Log appended to report" line;
    // neither is a question, and both are recorded in §12.1 as RENDERING
    // requirements of the report instead:
    //
    //   - the date is `inspections.started_at`, stamped SERVER-SIDE when the
    //     inspection is created (§8). A typed date could disagree with it, and
    //     on an evidentiary document a contradictable date is worse than one
    //     the inspector cannot touch;
    //   - the photo log is assembled from the answers' photos at render time.
    //     Asking the inspector to assert it were true would be asking them to
    //     vouch for something the report does on its own.
    {
      key:  'signoff',
      name: 'Inspector Sign-Off & Verification',
      items: [
        {
          key:    'safety.signoff.declaration',
          prompt:
            'I hereby certify that the property listed above has undergone a comprehensive ' +
            'safety inspection on the date indicated, and all verified items meet standard ' +
            'operational safety guidelines.',
          remediation: 'none', default_actions: [],
        },
        {
          key:    'safety.signoff.signature',
          prompt: 'Inspector signature',
          response_type: 'photo', photo_required: true,
          remediation: 'none', default_actions: [],
        },
      ],
    },
  ],
}
