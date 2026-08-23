// lib/inspections/forms/safety.ts
//
// Property Safety & Risk Mitigation Inspection — docs/INSPECTIONS_SPEC.md §12.1.
// 42 top-level items across 7 sections. Runs 1× or 2× a year.
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
  version: 1,
  sections: [
    // ── 1 ────────────────────────────────────────────────────────────────────
    {
      key:  'fire',
      name: 'Fire Safety & Life Safety Systems',
      items: [
        {
          key:    'safety.fire.smoke_present',
          prompt: 'Smoke detectors present in all bedrooms and hallways',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'urgent',
          concern_key: 'smoke_detector_present',
          children: [{
            key:    'safety.fire.smoke_present_where',
            prompt: 'Which room needs a smoke detector?',
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
          key:    'safety.fire.co_present',
          prompt: 'CO detectors installed on every level with sleeping areas',
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
          key:    'safety.fire.evacuation_plan',
          prompt: 'Evacuation plan and emergency contacts posted where guests will see them',
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
          prompt: 'Handrails secure; treads slip-resistant and clear',
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
          prompt: 'Deck and balcony guardrails sound; posts secure; spindle spacing compliant',
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
          // The second clause matters more than the first: a standard
          // homeowner's policy that excludes short-term rental use is worse
          // than no policy, because the owner believes they are covered.
          key:    'safety.permits.liability_insurance',
          prompt: 'Liability insurance certificate current and covering short-term rental use',
          remediation: 'notify', default_actions: [],
        },
        {
          key:    'safety.permits.occupancy_limit',
          prompt: 'Occupancy limit posted, and consistent with the listing',
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
