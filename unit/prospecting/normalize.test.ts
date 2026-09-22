import { describe, it, expect } from 'vitest'
import {
  cleanText,
  normalizeState,
  normalizeEmail,
  normalizePhone,
  normalizeDomain,
  normalizeWebsite,
  parsePortfolio,
  normalizePms,
  normalizeName,
} from '@/lib/prospecting/normalize'

describe('cleanText', () => {
  it('collapses whitespace and strips zero-width characters', () => {
    expect(cleanText('  Blue​  Gems\n Mgmt ')).toBe('Blue Gems Mgmt')
  })
})

describe('normalizeState', () => {
  it('passes through a valid two-letter code', () => {
    expect(normalizeState('tn')).toBe('TN')
    expect(normalizeState('TN')).toBe('TN')
  })

  it('expands a full state name', () => {
    expect(normalizeState('tennessee')).toBe('TN')
    expect(normalizeState('  North Carolina ')).toBe('NC')
    expect(normalizeState('Washington DC')).toBe('DC')
  })

  it('returns null for an ambiguous abbreviation rather than guessing', () => {
    expect(normalizeState('Tenn.')).toBeNull()
    expect(normalizeState('')).toBeNull()
  })
})

describe('normalizeEmail', () => {
  it('lowercases and strips a mailto: prefix', () => {
    expect(normalizeEmail('MAILTO:Jane@Example.COM')).toBe('jane@example.com')
  })

  it('rejects anything that is not an address', () => {
    expect(normalizeEmail('jane at example.com')).toBeNull()
    expect(normalizeEmail('jane@example')).toBeNull()
    expect(normalizeEmail('')).toBeNull()
  })

  it('accepts a multi-label host', () => {
    expect(normalizeEmail('jane@mail.sub.example.co.uk')).toBe('jane@mail.sub.example.co.uk')
  })

  it('rejects a malformed host rather than splitting it another way', () => {
    expect(normalizeEmail('jane@example.')).toBeNull()
    expect(normalizeEmail('jane@.com')).toBeNull()
    expect(normalizeEmail('jane@a..com')).toBeNull()
    expect(normalizeEmail('a@b@c.com')).toBeNull()
  })
})

describe('normalizePhone', () => {
  it('parses a formatted NANP number', () => {
    expect(normalizePhone('(865) 555-0142')).toEqual({
      e164: '+18655550142',
      raw:  '(865) 555-0142',
    })
  })

  it('drops an extension from the dialable number but keeps it in raw', () => {
    const out = normalizePhone('865-555-0142 ext 12')
    expect(out.e164).toBe('+18655550142')
    expect(out.raw).toBe('865-555-0142 ext 12')
  })

  it('accepts a leading country code', () => {
    expect(normalizePhone('1-865-555-0142').e164).toBe('+18655550142')
  })

  it('drops an extension written without a space, and every spelling of it', () => {
    for (const written of [
      '865-555-0142x12',
      '865-555-0142 x12',
      '865-555-0142 ext 12',
      '865-555-0142 ext. 12',
      '865-555-0142 extension 12',
      '865-555-0142 EXT 12',
    ]) {
      expect(normalizePhone(written).e164).toBe('+18655550142')
    }
  })

  it('keeps an unparseable number as raw rather than discarding it', () => {
    expect(normalizePhone('555-0142')).toEqual({ e164: null, raw: '555-0142' })
  })

  it('rejects a NANP number with an invalid area code', () => {
    expect(normalizePhone('(165) 555-0142').e164).toBeNull()
  })

  it('returns nulls for an empty cell', () => {
    expect(normalizePhone('   ')).toEqual({ e164: null, raw: null })
  })
})

describe('normalizeDomain', () => {
  it('strips scheme, www and path', () => {
    expect(normalizeDomain('https://WWW.RoHoGo.com/rentals')).toBe('rohogo.com')
  })

  it('rejects a value with no dot', () => {
    expect(normalizeDomain('localhost')).toBeNull()
    expect(normalizeDomain(null)).toBeNull()
  })
})

describe('normalizeWebsite', () => {
  it('adds a scheme and lowercases the host', () => {
    expect(normalizeWebsite('RoHoGo.com/')).toBe('https://rohogo.com')
  })

  it('keeps a real path', () => {
    expect(normalizeWebsite('example.com/vacation-rentals')).toBe(
      'https://example.com/vacation-rentals',
    )
  })

  it('rejects a non-http scheme so the value is safe to render as a link', () => {
    expect(normalizeWebsite('javascript:alert(1)')).toBeNull()
  })

  it('rejects a foreign scheme instead of reinterpreting it as a host', () => {
    // Prefixing https:// does not fail here, it re-parses: the userinfo
    // becomes `mailto:jane` and the host becomes example.com, quietly storing
    // an email address as the company's website.
    expect(normalizeWebsite('mailto:jane@example.com')).toBeNull()
    expect(normalizeWebsite('ftp://files.example.com')).toBeNull()
  })

  it('rejects embedded credentials, which disguise the real host', () => {
    expect(normalizeWebsite('https://evil.example@real.example.com')).toBeNull()
  })

  it('still accepts a host with a port', () => {
    expect(normalizeWebsite('example.com:8080/rentals')).toBe('https://example.com/rentals')
  })
})

describe('parsePortfolio', () => {
  it('reads a plain count', () => {
    expect(parsePortfolio('80')).toBe(80)
    expect(parsePortfolio('1,200')).toBe(1200)
  })

  it('reads a range as its midpoint', () => {
    expect(parsePortfolio('40-50')).toBe(45)
    expect(parsePortfolio('40 to 50')).toBe(45)
  })

  it('reads an approximation and a floor as the stated number', () => {
    expect(parsePortfolio('~45')).toBe(45)
    expect(parsePortfolio('50+')).toBe(50)
  })

  it('reads a leading count out of prose', () => {
    expect(parsePortfolio('6 private cabins (Dall, Loon, Moose)')).toBe(6)
  })

  it('returns null when the number is not a door count this column can carry', () => {
    // "at least 150" is not a quantity an integer column can carry, and the
    // raw text survives in portfolio_size_method.
    expect(parsePortfolio('est. 150+')).toBeNull()
    expect(parsePortfolio('est. 40-50')).toBeNull()
    expect(parsePortfolio('Part of a national network managing $16B+ in assets')).toBeNull()
    expect(parsePortfolio('n/a')).toBeNull()
    expect(parsePortfolio('')).toBeNull()
  })

  it('rejects an implausible count', () => {
    expect(parsePortfolio('999999')).toBeNull()
  })
})

describe('normalizePms', () => {
  it('canonicalises spelling variants to one product', () => {
    expect(normalizePms('owner rez').pms).toBe('OwnerRez')
    expect(normalizePms('TrackHS').pms).toBe('Track')
    expect(normalizePms('Streamline VRS').pms).toBe('Streamline')
    expect(normalizePms('Ciirus').pms).toBe('CiiRUS')
  })

  it('splits a crawler fingerprint into evidence — the 142-value facet bug', () => {
    expect(normalizePms('Streamline (ownerx.streamlinevrs.com)')).toEqual({
      pms:      'Streamline',
      evidence: 'ownerx.streamlinevrs.com',
    })
    expect(normalizePms('Streamline (owner.streamlinevrs.com)').pms).toBe('Streamline')
    expect(normalizePms('Streamline (streamlinevrs.com)').pms).toBe('Streamline')
  })

  it('keeps every parenthetical and every trailing clause as evidence', () => {
    expect(normalizePms('Escapia (owner.escapia.com); Rezfusion/Bluetent front end')).toEqual({
      pms:      'Escapia',
      evidence: 'owner.escapia.com; Rezfusion/Bluetent front end',
    })
    expect(
      normalizePms('Streamline (ownerx.streamlinevrs.com, happystays.streamlinevrs.com)').evidence,
    ).toBe('ownerx.streamlinevrs.com, happystays.streamlinevrs.com')
  })

  it('canonicalises case-variant brands', () => {
    expect(normalizePms('Brightside (smokymountain.bookonthebrightside.com RM4 owner portal)')).toEqual({
      pms:      'BrightSide',
      evidence: 'smokymountain.bookonthebrightside.com RM4 owner portal',
    })
    expect(normalizePms('RentVine (seen)')).toEqual({ pms: 'Rentvine', evidence: 'seen' })
    expect(normalizePms('Wander OS (wander.com/os)').pms).toBe('Wander')
    expect(normalizePms('Wander (wander.com/os)').pms).toBe('Wander')
  })

  it('still recognises Track in each shape it is written', () => {
    expect(normalizePms('Track').pms).toBe('Track')
    expect(normalizePms('Track HS').pms).toBe('Track')
    expect(normalizePms('Track (gcpm.trackhs.com)').pms).toBe('Track')
    expect(normalizePms('gcpm.trackhs.com').pms).toBe('Track')
  })

  it('leaves an unclosed parenthesis in place rather than swallowing the rest', () => {
    expect(normalizePms('Guesty (owners.guestyowners.com')).toEqual({
      pms:      'Guesty',
      evidence: null,
    })
  })

  it('keeps an uncatalogued product name verbatim', () => {
    expect(normalizePms('Acme PMS')).toEqual({ pms: 'Acme PMS', evidence: null })
  })

  it('moves prose out of pms and into evidence rather than dropping it', () => {
    expect(normalizePms('website directs to AirBnB')).toEqual({
      pms:      null,
      evidence: 'website directs to AirBnB',
    })
    // A spilled fragment from an unquoted comma in the size column.
    expect(normalizePms(' not local count)')).toEqual({
      pms:      null,
      evidence: 'not local count)',
    })
  })

  it('returns nulls for an empty cell', () => {
    expect(normalizePms('   ')).toEqual({ pms: null, evidence: null })
  })
})

describe('normalizeName', () => {
  it('ignores case, punctuation and a legal suffix', () => {
    expect(normalizeName('The Blue Gems Mgmt, LLC')).toBe(normalizeName('blue gems mgmt'))
  })

  it('treats & and "and" as the same', () => {
    expect(normalizeName('Peak & Pine Rentals')).toBe(normalizeName('Peak and Pine Rentals'))
  })

  it('keeps genuinely different companies distinct', () => {
    expect(normalizeName('Elite Vacation Rentals')).not.toBe(normalizeName('Elite Rentals'))
  })
})
