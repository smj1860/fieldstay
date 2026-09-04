import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildRequestFlowUrl,
  isThumbtackConfigured,
  THUMBTACK_CATEGORY_MAP,
  searchThumbtackPros,
  type ThumbtackCategoryKey,
} from '@/lib/integrations/thumbtack'
import type { WoCategory, CrewRole } from '@/types/database'

const ALL_WO_CATEGORIES: WoCategory[] = [
  'hvac', 'plumbing', 'electrical', 'appliance', 'cleaning', 'landscaping',
  'roofing', 'flooring', 'windows_doors', 'pest_control', 'pool', 'structural',
  'general', 'other',
]
const ALL_CREW_ROLES: CrewRole[] = ['cleaning', 'landscaping', 'maintenance', 'general']

describe('buildRequestFlowUrl', () => {
  it('builds the exact query shape from Thumbtack\'s Request Flow Widget doc', () => {
    const url = buildRequestFlowUrl({
      environment: 'https://thumbtack.com',
      categoryPk:  'cat_123',
      servicePk:   'svc_456',
      zipCode:     '90210',
      utmSource:   'cma-fieldstay',
    })
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://thumbtack.com')
    expect(parsed.pathname).toBe('/embed/request-flow')
    expect(parsed.searchParams.get('category_pk')).toBe('cat_123')
    expect(parsed.searchParams.get('service_pk')).toBe('svc_456')
    expect(parsed.searchParams.get('zip_code')).toBe('90210')
    expect(parsed.searchParams.get('utm_medium')).toBe('partnerships')
    expect(parsed.searchParams.get('utm_source')).toBe('cma-fieldstay')
  })

  it('omits zip_code when not provided, rather than sending an empty param', () => {
    const url = buildRequestFlowUrl({
      environment: 'https://thumbtack.com',
      categoryPk:  'cat_123',
      servicePk:   'svc_456',
      utmSource:   'cma-fieldstay',
    })
    expect(new URL(url).searchParams.has('zip_code')).toBe(false)
  })

  it('accepts extra utm_-prefixed params', () => {
    const url = buildRequestFlowUrl({
      environment:    'https://staging-partner.thumbtack.com',
      categoryPk:     'cat_123',
      servicePk:      'svc_456',
      utmSource:      'cma-fieldstay',
      extraUtmParams: { utm_campaign: 'crew-page' },
    })
    expect(new URL(url).searchParams.get('utm_campaign')).toBe('crew-page')
  })

  it('rejects a non-utm_-prefixed extra param rather than silently sending it', () => {
    expect(() => buildRequestFlowUrl({
      environment:    'https://thumbtack.com',
      categoryPk:     'cat_123',
      servicePk:      'svc_456',
      utmSource:      'cma-fieldstay',
      extraUtmParams: { campaign: 'crew-page' },
    })).toThrow(/utm_-prefixed/)
  })
})

describe('isThumbtackConfigured', () => {
  const KEYS = ['THUMBTACK_ENVIRONMENT', 'THUMBTACK_API_KEY', 'THUMBTACK_UTM_SOURCE'] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    for (const k of KEYS) delete process.env[k]
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('is false when none of the three env vars are set', () => {
    expect(isThumbtackConfigured()).toBe(false)
  })

  it('is false when only some of the three are set', () => {
    process.env.THUMBTACK_ENVIRONMENT = 'https://thumbtack.com'
    process.env.THUMBTACK_API_KEY = 'key'
    expect(isThumbtackConfigured()).toBe(false)
  })

  it('is true once all three are set', () => {
    process.env.THUMBTACK_ENVIRONMENT = 'https://thumbtack.com'
    process.env.THUMBTACK_API_KEY = 'key'
    process.env.THUMBTACK_UTM_SOURCE = 'cma-fieldstay'
    expect(isThumbtackConfigured()).toBe(true)
  })
})

describe('THUMBTACK_CATEGORY_MAP', () => {
  it('has an entry for every WoCategory and CrewRole value', () => {
    const keys: ThumbtackCategoryKey[] = [...ALL_WO_CATEGORIES, ...ALL_CREW_ROLES]
    for (const key of keys) {
      expect(THUMBTACK_CATEGORY_MAP, `missing entry for "${key}"`).toHaveProperty(key)
    }
  })

  it('maps every category except "other" to a real category_pk', () => {
    for (const [key, value] of Object.entries(THUMBTACK_CATEGORY_MAP)) {
      if (key === 'other') {
        expect(value, '"other" is deliberately unmapped').toBeNull()
      } else {
        expect(value, `"${key}" should have a category_pk`).toEqual(expect.stringMatching(/^\d+$/))
      }
    }
  })
})

describe('searchThumbtackPros', () => {
  it('throws — not yet implemented, pending confirmed API details', async () => {
    await expect(searchThumbtackPros({ categoryKey: 'plumbing', zipCode: '90210' }))
      .rejects.toThrow(/not yet implemented/)
  })
})
