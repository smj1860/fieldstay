// lib/inspections/forms/indoor.ts
//
// Indoor Property & Inventory Inspection — docs/INSPECTIONS_SPEC.md §12.2.
// 52 top-level items across 6 walked sections, an asset section rendered from
// the ledger, and a sign-off. Quarterly or 2× a year.
//
// THE OVERLAPS WITH SAFETY ARE DELIBERATE. Safety runs 1–2×/year and this runs
// quarterly; routing detectors, shut-offs and panels to Safety alone lets a
// dead detector sit for six months. Every overlapping item carries the same
// `concern_key` as its Safety twin, so the QUESTION is asked on the faster
// cadence while the WORK ORDER is deduplicated across both forms.
//
// TWO ITEMS HERE ARE LINKS, NOT CHECKBOXES — 20 (kitchenware) and 29 (linens).
// Counting against par already has a whole machine behind it: par_level, the
// count flow, auto-PO below par, the Kroger cart. Asking again here would give
// two systems answering "are we short on flatware", and the inspection's answer
// would bypass the tested restock path. These record THAT a count happened.

import { assetsSection, signoffSection } from './shared-sections'
import type { FormDefinition } from './types'

export const INDOOR_FORM: FormDefinition = {
  key:     'indoor',
  name:    'Indoor Property & Inventory Inspection',
  description:
    'Interior condition, appliances, plumbing, electronics and inventory, walked ' +
    'room by room. Runs on the quarterly cadence so anything that degrades between ' +
    'Safety inspections is caught in weeks rather than months.',
  version: 1,
  sections: [
    // ── 1 ────────────────────────────────────────────────────────────────────
    {
      key:  'entry_interior',
      name: 'Entryway, Hallways & General Interior',
      items: [
        {
          key:    'indoor.entry_interior.entry_locks',
          prompt: 'Entry locks and hardware — smart lock responds, latch aligned, deadbolt operates',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general', wo_priority: 'high',
          asset_type: 'smart_lock',
          per_unit: true, concern_key: 'entry_lock_operational',
        },
        {
          key:    'indoor.entry_interior.walls_ceilings',
          prompt: 'Walls, trim and ceilings — no holes, cracks, water staining or scuffed baseboards',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general',
          children: [{
            key:    'indoor.entry_interior.walls_touch_up',
            prompt: 'Touch-up paint or patching needed',
            show_when: 'fail',
            remediation: 'work_order', default_actions: ['repair'],
            wo_category: 'general',
          }],
        },
        {
          key:    'indoor.entry_interior.flooring',
          prompt: 'Flooring and rugs — clean, no chips, warping or slip hazards',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'flooring',
          concern_key: 'flooring_sound',
          children: [{
            key:    'indoor.entry_interior.flooring_treatment',
            prompt: 'Shampoo, reseal or re-coat needed',
            show_when: 'fail',
            remediation: 'work_order', default_actions: ['service'],
            wo_category: 'flooring',
          }],
        },
        {
          key:    'indoor.entry_interior.doors_windows',
          prompt: 'Doors and windows — lock, glass intact, screens present, tracks clear, weatherstripping sound',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'windows_doors',
        },
        {
          key:    'indoor.entry_interior.egress_windows',
          prompt: 'Bedroom egress windows open fully from inside without a tool',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'windows_doors', wo_priority: 'urgent',
          concern_key: 'egress_window',
        },
        {
          key:    'indoor.entry_interior.window_coverings',
          prompt: 'Window coverings — blinds and curtains operate, clean, cords secured out of child reach',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          key:    'indoor.entry_interior.ceiling_fans',
          prompt: 'Ceiling fans — balanced, no wobble, both directions and all speeds work',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical',
        },
        {
          key:    'indoor.entry_interior.wall_mounted',
          prompt: 'Mirrors, wall art and shelving securely mounted',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general',
        },
        {
          key:    'indoor.entry_interior.stairs_handrails',
          prompt: 'Interior stairs and handrails secure; treads sound',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'structural', wo_priority: 'high',
          concern_key: 'handrail_secure',
        },
        {
          key:    'indoor.entry_interior.anti_tip',
          prompt: 'Tall furniture and wall-mounted TVs anti-tip anchored',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general', wo_priority: 'high',
          concern_key: 'furniture_anchored',
        },
        {
          key:    'indoor.entry_interior.attic_hatch',
          prompt: 'Attic or ceiling access hatch — closes properly, no staining around it',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general',
        },
        {
          // Not cosmetic. Odour is the earliest leak and mildew indicator on the
          // form, and the finding most likely to reach a review before a PM.
          key:    'indoor.entry_interior.no_odour',
          prompt: 'No musty, damp or sewer odour anywhere in the unit',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'general', wo_priority: 'high',
          children: [{
            key:    'indoor.entry_interior.odour_location',
            prompt: 'Where is the odour strongest?',
            response_type: 'text', show_when: 'fail',
            remediation: 'none', default_actions: [],
          }],
        },
        {
          key:    'indoor.entry_interior.hvac',
          prompt: 'HVAC — thermostat connected, temperature stable, filter clean, vents clear, coils clean',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'hvac',
          asset_type: 'hvac',
          per_unit: true, concern_key: 'hvac_filter',
        },
      ],
    },

    // ── 2 ────────────────────────────────────────────────────────────────────
    {
      key:  'kitchen',
      name: 'Kitchen & Dining',
      items: [
        {
          key:    'indoor.kitchen.refrigeration',
          prompt: 'Refrigeration — clean, holding < 40°F / < 0°F, ice maker works, no leaks, display works',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'appliance',
          asset_type: 'refrigerator',
          per_unit: true,
          children: [{
            key:    'indoor.kitchen.fridge_water_filter',
            prompt: 'Water filter within its service life',
            show_when: 'fail',
            remediation: 'purchase_order', default_actions: ['replace'],
            asset_type: 'refrigerator', concern_key: 'fridge_water_filter',
          }],
        },
        {
          key:    'indoor.kitchen.stove_oven',
          prompt: 'Stove, oven and exhaust — burners and drip pans clean, oven light works, elements heat, hood fan and light operate',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'appliance',
          asset_type: 'oven_range',
          per_unit: true,
        },
        {
          key:    'indoor.kitchen.dishwasher',
          prompt: 'Dishwasher — filter clean, spray arms clear, door seal intact, drains fully, no leaks',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'appliance',
          asset_type: 'dishwasher',
          per_unit: true,
        },
        {
          key:    'indoor.kitchen.microwave',
          prompt: 'Microwave — clean, turntable and door latch work, heats',
          remediation: 'purchase_order', default_actions: ['replace'],
          asset_type: 'microwave',
          per_unit: true,
        },
        {
          key:    'indoor.kitchen.small_appliances',
          prompt: 'Small appliances — coffee maker, toaster, kettle, mixer clean, cords undamaged, all operate',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          key:    'indoor.kitchen.under_sink',
          prompt: 'Plumbing and under-sink — aerator clear, disposal works, supply lines and drain DRY, no slow drains',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'plumbing', wo_priority: 'high',
          asset_type: 'plumbing_system', concern_key: 'under_sink_leak',
          children: [{
            key:    'indoor.kitchen.home_water_filter',
            prompt: 'Whole-home water filter within its service life',
            show_when: 'fail',
            remediation: 'purchase_order', default_actions: ['replace'],
            concern_key: 'home_water_filter',
          }],
        },
        {
          // A LINK, not a checkbox — see the file header. The count itself does
          // the restocking through the tested par/PO/Kroger path.
          key:    'indoor.kitchen.inventory_count',
          prompt: 'Cookware, dinnerware and flatware counted against the property’s inventory list',
          response_type: 'count',
          remediation: 'none', default_actions: [],
        },
      ],
    },

    // ── 3 ────────────────────────────────────────────────────────────────────
    {
      key:  'bathrooms',
      name: 'Bathrooms & Plumbing',
      items: [
        {
          key:    'indoor.bathrooms.sinks_faucets',
          prompt: 'Sinks and faucets — pressure adequate, hot water delivers, stoppers work, zero under-sink leaks',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'plumbing', wo_priority: 'high',
          asset_type: 'plumbing_system', concern_key: 'under_sink_leak',
        },
        {
          key:    'indoor.bathrooms.toilets',
          prompt: 'Toilets — flush cycle tested, fill valve shuts off, base anchored, supply line dry',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'plumbing',
          asset_type: 'plumbing_system',
        },
        {
          key:    'indoor.bathrooms.shower_tub',
          prompt: 'Shower and tub — grout and caulk intact, drains flow, no mineral buildup, grab bars secure, doors track properly',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'plumbing',
        },
        {
          key:    'indoor.bathrooms.exhaust_fans',
          prompt: 'Bathroom exhaust fans — blades clean, pull verified',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          key:    'indoor.bathrooms.gfci',
          prompt: 'GFCI outlets in every wet area test and reset correctly',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'high',
          asset_type: 'electrical_panel', concern_key: 'gfci_wet_areas',
        },
      ],
    },

    // ── 4 ────────────────────────────────────────────────────────────────────
    {
      key:  'bedrooms',
      name: 'Bedrooms & Sleeping Areas',
      items: [
        {
          key:    'indoor.bedrooms.beds_frames',
          prompt: 'Beds and frames — joints stable, headboard secure, slats undamaged',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general',
        },
        {
          key:    'indoor.bedrooms.mattresses',
          prompt: 'Mattresses — protector present and clean, no wear, sagging or staining',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          key:    'indoor.bedrooms.closets_storage',
          prompt: 'Closets and storage — hangers stocked, luggage racks sturdy, safe operational',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          // A LINK, not a checkbox — same reasoning as kitchen 20.
          key:    'indoor.bedrooms.linens_count',
          prompt: 'Linens, towels and bedding counted against the property’s inventory list',
          response_type: 'count',
          remediation: 'none', default_actions: [],
        },
        {
          // Shares `concern_key` with Safety 2. Asked here because this form
          // runs quarterly and Safety does not.
          key:    'indoor.bedrooms.smoke_detector',
          prompt: 'Smoke detector present and operational in every bedroom and hallway',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'urgent',
          concern_key: 'smoke_detector_operational',
        },
        {
          key:    'indoor.bedrooms.co_detector',
          prompt: 'CO detector operational on every level with sleeping areas',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'urgent',
          concern_key: 'co_detector_operational',
        },
      ],
    },

    // ── 5 ────────────────────────────────────────────────────────────────────
    {
      key:  'living_electronics',
      name: 'Living Areas, Furniture & Electronics',
      items: [
        {
          key:    'indoor.living_electronics.upholstered',
          prompt: 'Upholstered furniture — firm, clean, no stains, tears or frame wobble',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general',
        },
        {
          key:    'indoor.living_electronics.case_goods',
          prompt: 'Tables and case goods — sturdy, no loose legs, sharp edges or surface damage',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'general',
        },
        {
          key:    'indoor.living_electronics.tvs',
          prompt: 'TVs and entertainment — display and sound work, remotes present, streaming reset to the guest screen',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          key:    'indoor.living_electronics.wifi',
          prompt: 'Wifi — router and modem operational, speed test meets the advertised rate',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'other', wo_priority: 'high',
          concern_key: 'wifi_operational',
        },
        {
          key:    'indoor.living_electronics.posted_credentials',
          prompt: 'Posted wifi credentials and guidebook details match reality',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'other',
        },
        {
          key:    'indoor.living_electronics.lighting_outlets',
          prompt: 'Lighting and outlets — all bulbs work, no frayed cords, switches operate, wall plates uncracked',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          // One line covering a whole class of guest complaint, and the item
          // most likely to prevent a mid-stay call-out.
          key:    'indoor.living_electronics.battery_sweep',
          prompt: 'Battery sweep — detectors, smart locks, thermostats, noise sensors, remotes all above low-battery warning',
          remediation: 'purchase_order', default_actions: ['replace'],
          concern_key: 'battery_sweep',
        },
        {
          // The second clause is a compliance check, not a functional one: a
          // camera in the wrong room is a listing violation on every channel.
          key:    'indoor.living_electronics.monitors_cameras',
          prompt: 'Noise monitors and cameras — powered, reporting, and sited only in permitted areas',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'other', wo_priority: 'high',
        },
      ],
    },

    // ── 6 ────────────────────────────────────────────────────────────────────
    {
      key:  'utility_laundry',
      name: 'Utility, Laundry & Access',
      items: [
        {
          key:    'indoor.utility_laundry.washer',
          prompt: 'Washer — drum clean, drain hose clear, all cycles run, inlet filters clean',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'appliance',
          asset_type: 'washer',
          per_unit: true,
        },
        {
          key:    'indoor.utility_laundry.washer_supply_lines',
          prompt: 'Washer supply lines braided stainless, not rubber; no weeping at either end',
          remediation: 'purchase_order', default_actions: ['replace'],
          asset_type: 'washer',
          per_unit: true, concern_key: 'washer_supply_lines',
        },
        {
          key:    'indoor.utility_laundry.dryer',
          prompt: 'Dryer — lint trap clear, vent hose connected, exit point free of lint',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'appliance', wo_priority: 'high',
          asset_type: 'dryer',
          per_unit: true, concern_key: 'dryer_vent_clear',
        },
        {
          key:    'indoor.utility_laundry.water_heater',
          prompt: 'Water heater — set to ≤ 120°F, TPR valve clear, no corrosion or moisture at the base',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'plumbing', wo_priority: 'high',
          asset_type: 'water_heater',
          per_unit: true, concern_key: 'water_heater_condition',
        },
        {
          key:    'indoor.utility_laundry.main_shutoff',
          prompt: 'Main water shut-off labelled, accessible, valve tool present',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'plumbing',
          asset_type: 'plumbing_system', concern_key: 'main_shutoff',
        },
        {
          key:    'indoor.utility_laundry.electrical_panel',
          prompt: 'Electrical panel unobstructed, labelled, no tripped breakers or exposed wiring',
          remediation: 'work_order', default_actions: ['repair'],
          wo_category: 'electrical', wo_priority: 'high',
          asset_type: 'electrical_panel',
          per_unit: true, concern_key: 'electrical_panel_clear',
        },
        {
          key:    'indoor.utility_laundry.access_inventory',
          prompt: 'Access inventory — spare keys, lockbox codes and garage remotes all present and tested',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          // Deliberately NOT the same concern as Outdoor 27 (the enclosure).
          key:    'indoor.utility_laundry.indoor_bins',
          prompt: 'Indoor bins present, clean and undamaged',
          remediation: 'purchase_order', default_actions: ['replace'],
        },
        {
          // `pest_activity`, deliberately NOT Outdoor's `exterior_pest`: roaches
          // in a cabinet and a wasp nest over a doorway are not one job.
          key:    'indoor.utility_laundry.no_pests',
          prompt: 'Zero signs of pest activity in cabinets, corners and baseboards',
          remediation: 'work_order', default_actions: ['service'],
          wo_category: 'pest_control', wo_priority: 'high',
          concern_key: 'pest_activity',
          children: [{
            key:    'indoor.utility_laundry.pest_contract',
            prompt: 'Pest control contract current and visits on schedule',
            show_when: 'fail',
            remediation: 'work_order', default_actions: ['service'],
            wo_category: 'pest_control',
          }],
        },
      ],
    },

    assetsSection('indoor'),
    signoffSection('indoor'),
  ],
}
