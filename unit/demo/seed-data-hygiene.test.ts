import { describe, it, expect } from 'vitest'
import {
  DEMO_PROPERTIES, DEMO_CREW, DEMO_VENDORS, DEMO_ASSETS, DEMO_SPONSORS,
  demoOwnerContact,
} from '@/lib/demo/seed-data'

// The demo org lives in the PRODUCTION project. Real contact details leaking
// into the seed set would mean a live SMS or email to an actual person the
// moment SMS_ENABLED flips or a send path is added without an orgId. These
// assertions are the mechanical version of "fake data hygiene".

/** Reserved-for-fiction range: +1 (NPA) 555-0100 through 555-0199. */
const FICTIONAL_PHONE = /^\+1\d{3}555 ?01\d{2}$/

// One generated owner contact per property, plus a couple past the end to
// prove the generator stays in range for any portfolio size.
const ownerContacts = [
  ...DEMO_PROPERTIES.map((_p, i) => demoOwnerContact(i)),
  demoOwnerContact(49),
  demoOwnerContact(50),
  demoOwnerContact(137),
]

const allPhones = [
  ...DEMO_CREW.map((c) => c.phone),
  ...DEMO_VENDORS.map((v) => v.phone),
  ...DEMO_SPONSORS.map((s) => s.business_phone),
  ...ownerContacts.map((o) => o.phone),
]

const allEmails = [
  ...DEMO_CREW.map((c) => c.email),
  ...DEMO_VENDORS.map((v) => v.email),
  ...ownerContacts.map((o) => o.email),
]

describe('demo seed data hygiene', () => {
  it.each(allPhones)('phone %s is in the reserved fictional 555-01xx range', (phone) => {
    expect(phone).toMatch(FICTIONAL_PHONE)
  })

  it.each(allEmails)('email %s uses the reserved example.com domain', (email) => {
    expect(email.endsWith('@example.com')).toBe(true)
  })

  it('every sponsor website points at example.com', () => {
    for (const s of DEMO_SPONSORS) {
      expect(new URL(s.business_website).hostname).toBe('example.com')
    }
  })

  it('property keys are unique — downstream entities reference properties by key', () => {
    const keys = DEMO_PROPERTIES.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every asset references a property that exists', () => {
    const keys = new Set(DEMO_PROPERTIES.map((p) => p.key))
    for (const a of DEMO_ASSETS) {
      expect(keys.has(a.propertyKey), `asset "${a.name}" → unknown property "${a.propertyKey}"`).toBe(true)
    }
  })

  it('sponsor slot numbers are unique', () => {
    const slots = DEMO_SPONSORS.map((s) => s.slot_number)
    expect(new Set(slots).size).toBe(slots.length)
  })

  it('has at least two flagship properties for guidebook and owner-report depth', () => {
    expect(DEMO_PROPERTIES.filter((p) => p.flagship).length).toBeGreaterThanOrEqual(2)
  })

  it('crew scores stay within the 0–1 range the suggester assumes', () => {
    for (const c of DEMO_CREW) {
      expect(c.reliability_score).toBeGreaterThan(0)
      expect(c.reliability_score).toBeLessThanOrEqual(1)
      expect(c.capacity_score).toBeGreaterThan(0)
      expect(c.capacity_score).toBeLessThanOrEqual(1)
    }
  })

  it('includes assets near end of life so CapEx output is non-trivial', () => {
    const nearEol = DEMO_ASSETS.filter(
      (a) => a.installed_years_ago >= a.expected_lifespan_years - 2,
    )
    expect(nearEol.length).toBeGreaterThanOrEqual(3)
  })

  it('meets the blueprint entity-count floors', () => {
    expect(DEMO_PROPERTIES.length).toBeGreaterThanOrEqual(8)
    expect(DEMO_CREW.length).toBeGreaterThanOrEqual(4)
    expect(DEMO_VENDORS.length).toBeGreaterThanOrEqual(6)
    expect(DEMO_SPONSORS.length).toBeGreaterThanOrEqual(4)
    expect(DEMO_ASSETS.length).toBeGreaterThanOrEqual(20)
  })
})
