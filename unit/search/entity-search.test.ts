import { describe, it, expect } from 'vitest'

import { sanitizeSearchTerm, MAX_TERM_LENGTH } from '@/lib/search/entity-search-types'
import { canSeeKind } from '@/lib/search/entity-search'
import type { MemberRole } from '@/types/database'

// ============================================================================
// Portfolio-wide entity search.
//
// Two things are tested here and nothing else, because they are the two that
// fail SILENTLY. A broken ilike pattern shows up the first time anyone uses
// the palette; a term that smuggles a PostgREST filter operator, or a kind
// whose results a role should never have been offered, does not.
// ============================================================================

describe('sanitizeSearchTerm', () => {
  it('keeps an ordinary multi-word term intact', () => {
    expect(sanitizeSearchTerm('water heater')).toBe('water heater')
  })

  it('keeps the punctuation real portfolio names contain', () => {
    // Stripping these out of the TERM cannot strip them out of the stored
    // name, so the match would just fail. This is the regression that makes
    // the allowlist deliberately wider than "letters and digits".
    expect(sanitizeSearchTerm("O'Brien Cabin")).toBe("O'Brien Cabin")
    expect(sanitizeSearchTerm('Smith & Sons')).toBe('Smith & Sons')
    expect(sanitizeSearchTerm('WO-1042')).toBe('WO-1042')
    expect(sanitizeSearchTerm('#204')).toBe('#204')
  })

  describe('strips every character that would change the filter expression', () => {
    // Each of these is an operator inside a PostgREST `.or()` string, not a
    // character to search for. A comma ends the condition, parentheses open a
    // group, and `*`/`%` are ilike wildcards that would match the whole table.
    const cases: ReadonlyArray<[string, string]> = [
      ['a,b',    'a b'],
      ['a)or(b', 'a or b'],
      ['a%b',    'a b'],
      ['a*b',    'a b'],
      ['a"b',    'a b'],
      ['a\\b',   'a b'],
    ]

    it.each(cases)('%s', (raw, expected) => {
      expect(sanitizeSearchTerm(raw)).toBe(expected)
    })
  })

  it('leaves a dot alone, because quoting is what makes it inert', () => {
    // `.` is legitimate in an address or a name, and the term is interpolated
    // into a DOUBLE-QUOTED value (`ilike."*term*"`), so an operator-looking
    // string cannot escape it. Stripping the dot would cost real matches to
    // defend against something quoting already handles. The allowlist's job
    // is the delimiters, not this.
    expect(sanitizeSearchTerm('title.ilike.x')).toBe('title.ilike.x')
  })

  it('collapses runs of whitespace left behind by stripping', () => {
    expect(sanitizeSearchTerm('a,,,b')).toBe('a b')
  })

  it('returns null below the minimum length, before and after cleaning', () => {
    expect(sanitizeSearchTerm('a')).toBeNull()
    expect(sanitizeSearchTerm('   ')).toBeNull()
    // Cleaning is what takes this one under the limit — the raw string is long
    // enough, which is exactly why the check has to run on the cleaned value.
    expect(sanitizeSearchTerm('%%%%%%')).toBeNull()
  })

  it('truncates a paste rather than searching on it', () => {
    const term = sanitizeSearchTerm('x'.repeat(MAX_TERM_LENGTH + 50))
    expect(term).not.toBeNull()
    expect(term!.length).toBe(MAX_TERM_LENGTH)
  })
})

describe('canSeeKind', () => {
  it('offers a viewer only what a viewer can open', () => {
    // A viewer's nav has /properties but neither /maintenance nor /vendors,
    // so returning a work order to one would be a result that 403s on click.
    expect(canSeeKind('viewer', 'property')).toBe(true)
    expect(canSeeKind('viewer', 'work_order')).toBe(false)
    expect(canSeeKind('viewer', 'vendor')).toBe(false)
  })

  it('offers every kind to admin, manager and owner', () => {
    const roles: MemberRole[] = ['admin', 'manager', 'owner']
    for (const role of roles) {
      expect(canSeeKind(role, 'work_order')).toBe(true)
      expect(canSeeKind(role, 'property')).toBe(true)
      expect(canSeeKind(role, 'vendor')).toBe(true)
    }
  })

  it('offers the finance role nothing', () => {
    // Finance sees /billing and /help. No operational page resolves for them,
    // so no operational result may either — the role's value IS the absence.
    expect(canSeeKind('finance', 'work_order')).toBe(false)
    expect(canSeeKind('finance', 'property')).toBe(false)
    expect(canSeeKind('finance', 'vendor')).toBe(false)
  })

  it('offers a crew member nothing', () => {
    // Crew have no PM nav at all. They reach their own work through the crew
    // PWA, whose Dexie scope is their assignments only.
    expect(canSeeKind('crew', 'work_order')).toBe(false)
    expect(canSeeKind('crew', 'property')).toBe(false)
    expect(canSeeKind('crew', 'vendor')).toBe(false)
  })
})
