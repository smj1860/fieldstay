/**
 * Canned dataset for the roadshow demo org.
 *
 * Pure data, no logic — but the realism is what sells, so it is not thin.
 * Gulf Shores / Orange Beach, AL to match the event location: a PM in that
 * room should recognize the street names and the seasonal maintenance rhythm.
 *
 * FAKE DATA HYGIENE (enforced by unit/demo/seed-data-hygiene.test.ts):
 *   - every phone is a 555 number in the reserved 555-01xx range
 *   - every email is @example.com
 *   - every business name is invented
 * No real customer, vendor, guest, or sponsor data ever enters this file.
 */

import type { AssetType, MacrsClass, VendorSpecialty, CrewRole } from '@/types/database'

export const DEMO_ORG_NAME = 'Gulf Coast Stays (Demo)'

/** Relative day offsets are resolved against seed time so data never goes stale. */
export interface DemoPropertySeed {
  key:              string
  name:             string
  address:          string
  city:             string
  state:            string
  zip:              string
  property_type:    'house' | 'condo' | 'cabin' | 'cottage' | 'townhouse' | 'other'
  bedrooms:         number
  bathrooms:        number
  max_guests:       number
  square_footage:   number
  avg_nightly_rate: number
  cleaning_cost:    number
  lat:              number
  lng:              number
  /** Flagship properties get full guidebook + owner-report depth. */
  flagship:         boolean
}

export const DEMO_PROPERTIES: DemoPropertySeed[] = [
  {
    key: 'sandpiper', name: 'Sandpiper Cottage',
    address: '1204 W Beach Blvd', city: 'Gulf Shores', state: 'AL', zip: '36542',
    property_type: 'cottage', bedrooms: 3, bathrooms: 2, max_guests: 8,
    square_footage: 1650, avg_nightly_rate: 385, cleaning_cost: 165,
    lat: 30.2458, lng: -87.7083, flagship: true,
  },
  {
    key: 'pelican', name: 'Pelican Perch 402',
    address: '400 Perdido Beach Blvd Unit 402', city: 'Orange Beach', state: 'AL', zip: '36561',
    property_type: 'condo', bedrooms: 2, bathrooms: 2, max_guests: 6,
    square_footage: 1180, avg_nightly_rate: 295, cleaning_cost: 130,
    lat: 30.2714, lng: -87.5639, flagship: true,
  },
  {
    key: 'dunes', name: 'Dune Ridge Retreat',
    address: '867 E 3rd Ave', city: 'Gulf Shores', state: 'AL', zip: '36542',
    property_type: 'house', bedrooms: 4, bathrooms: 3, max_guests: 10,
    square_footage: 2340, avg_nightly_rate: 520, cleaning_cost: 215,
    lat: 30.2491, lng: -87.6882, flagship: false,
  },
  {
    key: 'heron', name: 'Blue Heron Bungalow',
    address: '215 Windward Ct', city: 'Gulf Shores', state: 'AL', zip: '36542',
    property_type: 'house', bedrooms: 3, bathrooms: 2, max_guests: 7,
    square_footage: 1490, avg_nightly_rate: 310, cleaning_cost: 150,
    lat: 30.2567, lng: -87.7125, flagship: false,
  },
  {
    key: 'tideline', name: 'Tideline Townhome 7B',
    address: '3300 Bayou Rd Unit 7B', city: 'Orange Beach', state: 'AL', zip: '36561',
    property_type: 'townhouse', bedrooms: 3, bathrooms: 2.5, max_guests: 8,
    square_footage: 1720, avg_nightly_rate: 340, cleaning_cost: 160,
    lat: 30.2842, lng: -87.5911, flagship: false,
  },
  {
    key: 'mariner', name: 'Mariner Cove 11',
    address: '890 Canal Dr Unit 11', city: 'Orange Beach', state: 'AL', zip: '36561',
    property_type: 'condo', bedrooms: 2, bathrooms: 2, max_guests: 6,
    square_footage: 1050, avg_nightly_rate: 265, cleaning_cost: 125,
    lat: 30.2798, lng: -87.5746, flagship: false,
  },
  {
    key: 'seaoats', name: 'Sea Oats Hideaway',
    address: '412 Cotton Bayou Dr', city: 'Orange Beach', state: 'AL', zip: '36561',
    property_type: 'house', bedrooms: 5, bathrooms: 4, max_guests: 12,
    square_footage: 2980, avg_nightly_rate: 675, cleaning_cost: 270,
    lat: 30.2763, lng: -87.5568, flagship: false,
  },
  {
    key: 'lagoon', name: 'Lagoon Pass Cabin',
    address: '77 Lagoon Pass Rd', city: 'Gulf Shores', state: 'AL', zip: '36542',
    property_type: 'cabin', bedrooms: 2, bathrooms: 1, max_guests: 5,
    square_footage: 940, avg_nightly_rate: 205, cleaning_cost: 110,
    lat: 30.2412, lng: -87.7239, flagship: false,
  },
  {
    key: 'starfish', name: 'Starfish Landing 208',
    address: '1000 W Beach Blvd Unit 208', city: 'Gulf Shores', state: 'AL', zip: '36542',
    property_type: 'condo', bedrooms: 1, bathrooms: 1, max_guests: 4,
    square_footage: 720, avg_nightly_rate: 175, cleaning_cost: 95,
    lat: 30.2451, lng: -87.7034, flagship: false,
  },
]

export interface DemoCrewSeed {
  key:               string
  name:              string
  email:             string
  phone:             string
  role:              CrewRole
  home_zip:          string
  home_lat:          number
  home_lng:          number
  reliability_score: number
  capacity_score:    number
}

/**
 * Deliberately varied scores and home locations — the assignment suggester
 * has to make a real choice, and its reasoning string has to say something
 * non-obvious when it does.
 */
export const DEMO_CREW: DemoCrewSeed[] = [
  {
    key: 'maria', name: 'Maria Delgado', email: 'maria.delgado@example.com', phone: '+12515550142',
    role: 'cleaning', home_zip: '36542', home_lat: 30.2479, home_lng: -87.7012,
    reliability_score: 0.97, capacity_score: 0.82,
  },
  {
    key: 'dwight', name: 'Dwight Abernathy', email: 'dwight.abernathy@example.com', phone: '+12515550178',
    role: 'maintenance', home_zip: '36561', home_lat: 30.2815, home_lng: -87.5703,
    reliability_score: 0.91, capacity_score: 0.95,
  },
  {
    key: 'tasha', name: 'Tasha Boudreaux', email: 'tasha.boudreaux@example.com', phone: '+12515550113',
    role: 'cleaning', home_zip: '36561', home_lat: 30.2742, home_lng: -87.5617,
    reliability_score: 0.88, capacity_score: 0.60,
  },
  {
    key: 'ronnie', name: 'Ronnie Pyle', email: 'ronnie.pyle@example.com', phone: '+12515550167',
    role: 'general', home_zip: '36542', home_lat: 30.2524, home_lng: -87.7168,
    reliability_score: 0.94, capacity_score: 0.71,
  },
  {
    key: 'jolene', name: 'Jolene Fairweather', email: 'jolene.fairweather@example.com', phone: '+12515550190',
    role: 'landscaping', home_zip: '36542', home_lat: 30.2396, home_lng: -87.6945,
    reliability_score: 0.85, capacity_score: 0.88,
  },
]

export interface DemoVendorSeed {
  key:          string
  name:         string
  contact_name: string
  email:        string
  phone:        string
  specialty:    VendorSpecialty
  city:         string
  state:        string
  service_zip:  string
  lat:          number
  lng:          number
  avg_rating:   number
  rating_count: number
}

/**
 * All compliance current by design — a hard-block mid-demo would be an
 * accurate feature demonstration and a terrible sales moment.
 */
export const DEMO_VENDORS: DemoVendorSeed[] = [
  {
    key: 'saltair', name: 'Salt Air HVAC', contact_name: 'Curtis Nabors',
    email: 'dispatch@example.com', phone: '+12515550120', specialty: 'hvac',
    city: 'Gulf Shores', state: 'AL', service_zip: '36542',
    lat: 30.2503, lng: -87.6991, avg_rating: 4.7, rating_count: 34,
  },
  {
    key: 'tidewater', name: 'Tidewater Plumbing Co.', contact_name: 'Alma Rutledge',
    email: 'service@example.com', phone: '+12515550121', specialty: 'plumbing',
    city: 'Orange Beach', state: 'AL', service_zip: '36561',
    lat: 30.2781, lng: -87.5682, avg_rating: 4.5, rating_count: 21,
  },
  {
    key: 'gulfcurrent', name: 'Gulf Current Electric', contact_name: 'Percy Vandiver',
    email: 'office@example.com', phone: '+12515550122', specialty: 'electrical',
    city: 'Foley', state: 'AL', service_zip: '36535',
    lat: 30.4065, lng: -87.6834, avg_rating: 4.8, rating_count: 47,
  },
  {
    key: 'seagrass', name: 'Seagrass Lawn & Landscape', contact_name: 'Bettina Cormier',
    email: 'crew@example.com', phone: '+12515550123', specialty: 'landscaping',
    city: 'Gulf Shores', state: 'AL', service_zip: '36542',
    lat: 30.2437, lng: -87.7106, avg_rating: 4.3, rating_count: 18,
  },
  {
    key: 'bluewave', name: 'Blue Wave Pool Service', contact_name: 'Hollis Trammell',
    email: 'schedule@example.com', phone: '+12515550124', specialty: 'pool',
    city: 'Orange Beach', state: 'AL', service_zip: '36561',
    lat: 30.2729, lng: -87.5795, avg_rating: 4.6, rating_count: 29,
  },
  {
    key: 'coastguard', name: 'Coast Guard Pest Control', contact_name: 'Rosalind Peavy',
    email: 'bookings@example.com', phone: '+12515550125', specialty: 'pest_control',
    city: 'Gulf Shores', state: 'AL', service_zip: '36542',
    lat: 30.2548, lng: -87.6923, avg_rating: 4.4, rating_count: 25,
  },
  {
    key: 'shorehouse', name: 'Shorehouse General Contracting', contact_name: 'Emmett Pardue',
    email: 'builds@example.com', phone: '+12515550126', specialty: 'general',
    city: 'Orange Beach', state: 'AL', service_zip: '36561',
    lat: 30.2836, lng: -87.5857, avg_rating: 4.9, rating_count: 52,
  },
]

export interface DemoAssetSeed {
  propertyKey:                string
  name:                       string
  asset_type:                 AssetType
  make:                       string
  model:                      string
  /** Years before seed time the unit was installed. Drives health score. */
  installed_years_ago:        number
  purchase_price:             number
  estimated_replacement_cost: number
  expected_lifespan_years:    number
  macrs_class:                MacrsClass
}

/**
 * Ages are chosen so the CapEx projection has a real story: several units are
 * within 2 years of end-of-life, which is what makes the depreciation ledger
 * and replacement-planning output non-trivial rather than a wall of "fine".
 */
export const DEMO_ASSETS: DemoAssetSeed[] = [
  // Sandpiper Cottage — flagship, deliberately aging HVAC + water heater
  { propertyKey: 'sandpiper', name: 'Main HVAC Condenser', asset_type: 'hvac', make: 'Trane', model: 'XR14-036', installed_years_ago: 13, purchase_price: 6800, estimated_replacement_cost: 8900, expected_lifespan_years: 15, macrs_class: '15_year' },
  { propertyKey: 'sandpiper', name: 'Water Heater (50 gal)', asset_type: 'water_heater', make: 'Rheem', model: 'PROG50-38N', installed_years_ago: 11, purchase_price: 1250, estimated_replacement_cost: 1750, expected_lifespan_years: 12, macrs_class: '5_year' },
  { propertyKey: 'sandpiper', name: 'Kitchen Refrigerator', asset_type: 'refrigerator', make: 'Whirlpool', model: 'WRS588FIHZ', installed_years_ago: 4, purchase_price: 2100, estimated_replacement_cost: 2400, expected_lifespan_years: 13, macrs_class: '5_year' },
  { propertyKey: 'sandpiper', name: 'Roof (Architectural Shingle)', asset_type: 'roof', make: 'GAF', model: 'Timberline HDZ', installed_years_ago: 9, purchase_price: 18500, estimated_replacement_cost: 24000, expected_lifespan_years: 25, macrs_class: '27_5_year' },
  { propertyKey: 'sandpiper', name: 'Front Door Smart Lock', asset_type: 'smart_lock', make: 'Schlage', model: 'BE489WB', installed_years_ago: 2, purchase_price: 340, estimated_replacement_cost: 380, expected_lifespan_years: 8, macrs_class: '5_year' },

  // Pelican Perch — flagship condo
  { propertyKey: 'pelican', name: 'HVAC Air Handler', asset_type: 'hvac', make: 'Carrier', model: 'FV4CNF003', installed_years_ago: 7, purchase_price: 4200, estimated_replacement_cost: 5600, expected_lifespan_years: 15, macrs_class: '15_year' },
  { propertyKey: 'pelican', name: 'Water Heater (40 gal)', asset_type: 'water_heater', make: 'AO Smith', model: 'GCR-40', installed_years_ago: 10, purchase_price: 980, estimated_replacement_cost: 1400, expected_lifespan_years: 12, macrs_class: '5_year' },
  { propertyKey: 'pelican', name: 'Washer', asset_type: 'washer', make: 'LG', model: 'WM4000HWA', installed_years_ago: 5, purchase_price: 1050, estimated_replacement_cost: 1200, expected_lifespan_years: 11, macrs_class: '5_year' },
  { propertyKey: 'pelican', name: 'Dryer', asset_type: 'dryer', make: 'LG', model: 'DLEX4000W', installed_years_ago: 5, purchase_price: 990, estimated_replacement_cost: 1150, expected_lifespan_years: 13, macrs_class: '5_year' },
  { propertyKey: 'pelican', name: 'Dishwasher', asset_type: 'dishwasher', make: 'Bosch', model: 'SHXM63W55N', installed_years_ago: 8, purchase_price: 890, estimated_replacement_cost: 1050, expected_lifespan_years: 10, macrs_class: '5_year' },

  // Dune Ridge — pool property
  { propertyKey: 'dunes', name: 'Pool Pump', asset_type: 'pool_pump', make: 'Pentair', model: 'IntelliFlo VSF', installed_years_ago: 9, purchase_price: 1650, estimated_replacement_cost: 2100, expected_lifespan_years: 10, macrs_class: '15_year' },
  { propertyKey: 'dunes', name: 'Main HVAC Condenser', asset_type: 'hvac', make: 'Goodman', model: 'GSX160481', installed_years_ago: 6, purchase_price: 5400, estimated_replacement_cost: 7200, expected_lifespan_years: 15, macrs_class: '15_year' },
  { propertyKey: 'dunes', name: 'Hot Tub', asset_type: 'hot_tub', make: 'Jacuzzi', model: 'J-335', installed_years_ago: 8, purchase_price: 7800, estimated_replacement_cost: 9500, expected_lifespan_years: 12, macrs_class: '5_year' },
  { propertyKey: 'dunes', name: 'Electrical Panel', asset_type: 'electrical_panel', make: 'Square D', model: 'QO142M200PC', installed_years_ago: 14, purchase_price: 2200, estimated_replacement_cost: 3100, expected_lifespan_years: 30, macrs_class: '27_5_year' },
  { propertyKey: 'dunes', name: 'Garage Door Opener', asset_type: 'garage_door', make: 'Chamberlain', model: 'B970', installed_years_ago: 3, purchase_price: 620, estimated_replacement_cost: 700, expected_lifespan_years: 12, macrs_class: '5_year' },

  // Remaining properties — enough depth to make portfolio rollups real
  { propertyKey: 'heron', name: 'Main HVAC Condenser', asset_type: 'hvac', make: 'Rheem', model: 'RA1436AJ1NA', installed_years_ago: 12, purchase_price: 5100, estimated_replacement_cost: 7000, expected_lifespan_years: 15, macrs_class: '15_year' },
  { propertyKey: 'heron', name: 'Water Heater (40 gal)', asset_type: 'water_heater', make: 'Bradford White', model: 'RG240T6N', installed_years_ago: 3, purchase_price: 1100, estimated_replacement_cost: 1300, expected_lifespan_years: 12, macrs_class: '5_year' },
  { propertyKey: 'heron', name: 'Oven / Range', asset_type: 'oven_range', make: 'GE', model: 'JB645RKSS', installed_years_ago: 7, purchase_price: 780, estimated_replacement_cost: 950, expected_lifespan_years: 15, macrs_class: '5_year' },

  { propertyKey: 'tideline', name: 'Main HVAC Condenser', asset_type: 'hvac', make: 'Lennox', model: 'ML14XC1', installed_years_ago: 5, purchase_price: 5900, estimated_replacement_cost: 7400, expected_lifespan_years: 15, macrs_class: '15_year' },
  { propertyKey: 'tideline', name: 'Water Heater (50 gal)', asset_type: 'water_heater', make: 'Rheem', model: 'PROG50-38N', installed_years_ago: 12, purchase_price: 1180, estimated_replacement_cost: 1750, expected_lifespan_years: 12, macrs_class: '5_year' },
  { propertyKey: 'tideline', name: 'Refrigerator', asset_type: 'refrigerator', make: 'Samsung', model: 'RF23A9071SR', installed_years_ago: 2, purchase_price: 2600, estimated_replacement_cost: 2800, expected_lifespan_years: 13, macrs_class: '5_year' },

  { propertyKey: 'mariner', name: 'HVAC Air Handler', asset_type: 'hvac', make: 'Carrier', model: 'FB4CNP030', installed_years_ago: 10, purchase_price: 3900, estimated_replacement_cost: 5300, expected_lifespan_years: 15, macrs_class: '15_year' },
  { propertyKey: 'mariner', name: 'Dishwasher', asset_type: 'dishwasher', make: 'Whirlpool', model: 'WDT750SAKZ', installed_years_ago: 9, purchase_price: 700, estimated_replacement_cost: 850, expected_lifespan_years: 10, macrs_class: '5_year' },

  // A single row, not two — property_assets has a UNIQUE (property_id,
  // asset_type) WHERE is_active constraint (one canonical active asset per
  // type per property), so two physically-separate condensers on this
  // 2-zone house are modeled as one combined asset rather than a real
  // upstairs/downstairs split.
  { propertyKey: 'seaoats', name: 'Main HVAC Condensers (2-Zone, Upstairs & Downstairs)', asset_type: 'hvac', make: 'Trane', model: 'XR16-048 / XR16-036', installed_years_ago: 4, purchase_price: 15300, estimated_replacement_cost: 19700, expected_lifespan_years: 15, macrs_class: '15_year' },
  { propertyKey: 'seaoats', name: 'Pool Pump', asset_type: 'pool_pump', make: 'Hayward', model: 'TriStar VS 950', installed_years_ago: 6, purchase_price: 1800, estimated_replacement_cost: 2300, expected_lifespan_years: 10, macrs_class: '15_year' },
  { propertyKey: 'seaoats', name: 'Standby Generator', asset_type: 'generator', make: 'Generac', model: 'Guardian 24kW', installed_years_ago: 3, purchase_price: 9400, estimated_replacement_cost: 11800, expected_lifespan_years: 20, macrs_class: '15_year' },
  { propertyKey: 'seaoats', name: 'Roof (Metal Standing Seam)', asset_type: 'roof', make: 'McElroy', model: 'Medallion-Lok', installed_years_ago: 7, purchase_price: 41000, estimated_replacement_cost: 52000, expected_lifespan_years: 40, macrs_class: '27_5_year' },

  { propertyKey: 'lagoon', name: 'Water Heater (30 gal)', asset_type: 'water_heater', make: 'Rheem', model: 'PROG30-30N', installed_years_ago: 13, purchase_price: 820, estimated_replacement_cost: 1200, expected_lifespan_years: 12, macrs_class: '5_year' },
  { propertyKey: 'lagoon', name: 'Septic System', asset_type: 'septic_system', make: 'Infiltrator', model: 'Quick4 Plus', installed_years_ago: 16, purchase_price: 9800, estimated_replacement_cost: 14500, expected_lifespan_years: 30, macrs_class: '27_5_year' },

  { propertyKey: 'starfish', name: 'HVAC Wall Unit', asset_type: 'hvac', make: 'Mitsubishi', model: 'MSZ-GL12NA', installed_years_ago: 8, purchase_price: 2400, estimated_replacement_cost: 3100, expected_lifespan_years: 15, macrs_class: '15_year' },
  { propertyKey: 'starfish', name: 'Microwave', asset_type: 'microwave', make: 'GE', model: 'JVM3160RFSS', installed_years_ago: 9, purchase_price: 280, estimated_replacement_cost: 340, expected_lifespan_years: 9, macrs_class: '5_year' },
]

export interface DemoSponsorSeed {
  slot_number:         number
  business_name:       string
  business_description: string
  business_phone:      string
  business_website:    string
  address:             string
  lat:                 number
  lng:                 number
  slot_type:           string
  offer_type:          string
  offer_value:         number | null
  offer_item:          string | null
  custom_offer_text:   string | null
  featured_item:       string
}

export const DEMO_SPONSORS: DemoSponsorSeed[] = [
  {
    slot_number: 1, business_name: 'The Salty Mullet Grill',
    business_description: 'Gulf-to-table seafood on the west end — hush puppies worth the wait.',
    business_phone: '+12515550130', business_website: 'https://example.com/salty-mullet',
    address: '1520 W Beach Blvd, Gulf Shores, AL 36542', lat: 30.2449, lng: -87.7142,
    slot_type: 'dinner_pints', offer_type: 'percentage', offer_value: 10, offer_item: null,
    custom_offer_text: null, featured_item: 'Blackened grouper basket',
  },
  {
    slot_number: 2, business_name: 'Pelican Bait & Charter',
    business_description: 'Half-day inshore charters, rods and bait included.',
    business_phone: '+12515550131', business_website: 'https://example.com/pelican-charter',
    address: '27 Marina Way, Orange Beach, AL 36561', lat: 30.2864, lng: -87.5821,
    slot_type: 'outdoor_adventure', offer_type: 'fixed_amount', offer_value: 25, offer_item: null,
    custom_offer_text: null, featured_item: 'Half-day inshore charter',
  },
  {
    slot_number: 3, business_name: 'Driftwood Coffee Roasters',
    business_description: 'Small-batch roaster and espresso bar two blocks off the beach.',
    business_phone: '+12515550132', business_website: 'https://example.com/driftwood-coffee',
    address: '308 E 2nd Ave, Gulf Shores, AL 36542', lat: 30.2483, lng: -87.6967,
    slot_type: 'morning_brew', offer_type: 'item', offer_value: null, offer_item: 'pastry with any latte',
    custom_offer_text: null, featured_item: 'Honey lavender latte',
  },
  {
    slot_number: 4, business_name: 'Barefoot Bike & Board Rentals',
    business_description: 'Beach cruisers, paddleboards, and umbrellas delivered to your door.',
    business_phone: '+12515550133', business_website: 'https://example.com/barefoot-rentals',
    address: '905 Gulf Shores Pkwy, Gulf Shores, AL 36542', lat: 30.2561, lng: -87.7008,
    slot_type: 'general', offer_type: 'percentage', offer_value: 15, offer_item: null,
    custom_offer_text: null, featured_item: 'Two-bike day rental',
  },
  {
    slot_number: 5, business_name: 'Cotton Bayou Ice Cream Co.',
    business_description: 'Hand-churned scoops and dole whip, open till 10.',
    business_phone: '+12515550134', business_website: 'https://example.com/cotton-bayou-ice-cream',
    address: '450 Perdido Beach Blvd, Orange Beach, AL 36561', lat: 30.2736, lng: -87.5602,
    slot_type: 'rainy_day', offer_type: 'custom', offer_value: null, offer_item: null,
    custom_offer_text: 'Kids scoop free with any adult cone', featured_item: 'Satsuma sorbet',
  },
]

/**
 * Owner contact details, generated per property index.
 *
 * Lives here rather than inline in the seeder so it falls under the same
 * hygiene test as the hand-written records — an inline template literal in
 * seed.ts is exactly where an out-of-range phone number hid the first time.
 * Index 0..49 maps into the reserved 555-0150..555-0199 block.
 */
export function demoOwnerContact(index: number): { phone: string; email: string } {
  const line = 150 + (index % 50)
  return {
    phone: `+1251555${String(line).padStart(4, '0')}`,
    email: `owner${index + 1}@example.com`,
  }
}

/** Guest names for bookings — invented, paired with @example.com addresses. */
export const DEMO_GUEST_NAMES: readonly string[] = [
  'Harold Winterbourne', 'Priya Raghunathan', 'Marcus Delacroix', 'Ingrid Solberg',
  'Terrence Okafor', 'Lucia Bellandi', 'Nathan Grieve', 'Yuki Tomoda',
  'Rosalind Achterberg', 'Devon Marchetti', 'Simone Vaillancourt', 'Otis Brumfield',
  'Camille Nakagawa', 'Frederick Aldous', 'Nadia Petrossian', 'Wesley Thorncroft',
  'Beatriz Salcedo', 'Gideon Hallowell',
]
