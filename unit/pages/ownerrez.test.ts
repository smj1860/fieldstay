import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OWNERREZ_URL,
  OWNERREZ_PROMO_CODE,
  isOwnerRezOfferActive,
} from '@/app/ownerrez/launch-offer'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('OwnerRez launch offer', () => {
  it('uses the exact tracked URL OwnerRez supplied', () => {
    expect(OWNERREZ_URL).toBe(
      'https://www.ownerrez.com/?utm_source=fieldstay&utm_medium=website&utm_campaign=fieldstay',
    )
  })

  it('uses the promo code from the announcement', () => {
    expect(OWNERREZ_PROMO_CODE).toBe('OWNERREZ50')
  })

  it('is active on the last evening of December, Central time', () => {
    expect(isOwnerRezOfferActive(new Date('2026-12-31T23:59:00-06:00'))).toBe(true)
  })

  it('is over at midnight January 1, Central time', () => {
    expect(isOwnerRezOfferActive(new Date('2027-01-01T00:00:00-06:00'))).toBe(false)
  })
})

describe('/ownerrez page source', () => {
  const page = read('app/ownerrez/page.tsx')
  const banner = read('app/ownerrez/launch-banner.tsx')

  it('imports the offer constants from ./launch-offer', () => {
    expect(page).toContain("from './launch-offer'")
    expect(banner).toContain("from './launch-offer'")
  })

  it('never types the OwnerRez URL inline, so it can only be edited in one place', () => {
    expect(page).not.toContain('ownerrez.com')
    expect(banner).not.toContain('ownerrez.com')
    expect(banner).not.toContain('OWNERREZ50')
  })

  it('opens partner links safely', () => {
    expect(page).toContain('noopener')
    expect(banner).toContain('noopener')
    expect(page + banner).not.toMatch(/nofollow|sponsored/)
  })

  it('puts an account link in the nav, not only a login link', () => {
    // The nav used to hold a single Log In link, so a first-time visitor's most
    // visible way forward was a login form. Launch week showed 21 visitors on
    // /login and one account created.
    const nav = page.slice(page.indexOf('<nav'), page.indexOf('</nav>'))
    expect(nav).toContain('href="/signup?provider=ownerrez&next=/onboarding"')
    expect(nav).toContain('Create account')
    expect(nav).toContain('href="/login?next=/api/integrations/ownerrez/connect"')
  })

  it('revalidates so the banner can expire on a prerendered page', () => {
    expect(page).toMatch(/export const revalidate = 3600/)
  })
})
