import { describe, it, expect } from 'vitest'
import { signupHrefForLoginNext } from '@/lib/auth/signup-href'

// ============================================================================
// A partner landing page sends visitors to
// /login?next=/api/integrations/<provider>/connect. Someone with no account who
// clicks "Start free trial" there used to land on a bare /signup, dropping the
// provider that the partner page's own sign-up buttons carry.
// ============================================================================

describe('signupHrefForLoginNext', () => {
  it('carries the provider through for an OwnerRez connect redirect', () => {
    expect(signupHrefForLoginNext('/api/integrations/ownerrez/connect'))
      .toBe('/signup?provider=ownerrez&next=/onboarding')
  })

  it('does the same for any provider slug, matching the Hospitable page', () => {
    expect(signupHrefForLoginNext('/api/integrations/hospitable/connect'))
      .toBe('/signup?provider=hospitable&next=/onboarding')
  })

  it('still matches when the connect path carries a query string', () => {
    expect(signupHrefForLoginNext('/api/integrations/ownerrez/connect?x=1'))
      .toBe('/signup?provider=ownerrez&next=/onboarding')
  })

  it('falls back to a plain /signup for any other destination', () => {
    expect(signupHrefForLoginNext('/ops')).toBe('/signup')
    expect(signupHrefForLoginNext('/settings')).toBe('/signup')
  })

  it('falls back to a plain /signup when there is no next', () => {
    expect(signupHrefForLoginNext(null)).toBe('/signup')
    expect(signupHrefForLoginNext(undefined)).toBe('/signup')
    expect(signupHrefForLoginNext('')).toBe('/signup')
  })

  it('never lets the URL put anything but a slug into the link', () => {
    expect(signupHrefForLoginNext('/api/integrations/Ownerrez/connect')).toBe('/signup')
    expect(signupHrefForLoginNext('/api/integrations/own errez/connect')).toBe('/signup')
    expect(signupHrefForLoginNext('/api/integrations/a&next=//evil.example/connect')).toBe('/signup')
    expect(signupHrefForLoginNext('/api/integrations/ownerrez/connectx')).toBe('/signup')
  })

  it('rejects a path that only contains the connect segment further in', () => {
    expect(signupHrefForLoginNext('//evil.example/api/integrations/ownerrez/connect')).toBe('/signup')
    expect(signupHrefForLoginNext('/x/api/integrations/ownerrez/connect')).toBe('/signup')
  })
})
