import { describe, it, expect } from 'vitest'
import { parseCsv, csvCell, toCsv } from '@/lib/prospecting/csv'
import { autoMapColumns } from '@/lib/prospecting/columns'
import {
  mapRow,
  mapRows,
  keysOf,
  dedupe,
  buildPlan,
  type ExistingRow,
  type ProspectUpsert,
} from '@/lib/prospecting/import'

const HEADER = ['Company', 'City', 'State', 'Website', 'PMS', 'Portfolio Size (est.)', 'Email', 'Phone']

function upsert(over: Partial<ProspectUpsert> & { company: string }): ProspectUpsert {
  return {
    domain: null, website: null, comparent_url: null,
    city: null, state: null, market: null, region: null,
    portfolio_size: null, portfolio_size_method: null, pms: null, pms_note: null,
    score_a: null, score_b: null, track: null, bucket: null, gate: null,
    contact_name: null, contact_title: null, email: null, phone: null,
    linkedin_url: null, source: null,
    ...over,
  }
}

function existing(over: Partial<ExistingRow> & { id: string; company: string }): ExistingRow {
  return {
    domain: null, city: null, state: null, market: null, region: null,
    website: null, comparent_url: null, portfolio_size: null,
    portfolio_size_method: null, pms: null, pms_note: null,
    score_a: null, score_b: null, track: null, bucket: null, gate: null,
    source: null, contact_name: null, contact_title: null, email: null,
    phone: null, linkedin_url: null,
    ...over,
  }
}

describe('parseCsv', () => {
  it('keeps a quoted cell containing commas, quotes and newlines intact', () => {
    const grid = parseCsv('a,b\n"x, y","he said ""hi""\nagain"\n')
    expect(grid).toEqual([['a', 'b'], ['x, y', 'he said "hi"\nagain']])
  })

  it('strips a UTF-8 BOM so the first header still matches its alias', () => {
    const grid = parseCsv('﻿Company,City\nAcme,Knoxville\n')
    expect(grid[0][0]).toBe('Company')
    expect(autoMapColumns(grid[0]).company).toBe(0)
  })

  it('drops entirely blank lines', () => {
    expect(parseCsv('a,b\n\n,\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']])
  })
})

describe('csvCell', () => {
  it('quotes only what would break the row apart', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell(null)).toBe('')
  })

  it('defuses a value a spreadsheet would evaluate as a formula', () => {
    expect(csvCell('=SUM(1)')).toBe("'=SUM(1)")
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"')
    expect(csvCell('+1 865 555 0142')).toBe("'+1 865 555 0142")
    expect(csvCell('-5')).toBe("'-5")
  })
})

describe('toCsv', () => {
  it('leads with a BOM so Excel reads it as UTF-8', () => {
    expect(toCsv(['a'], [['x']]).startsWith('﻿')).toBe(true)
  })
})

describe('autoMapColumns', () => {
  it('maps the master sheet and queue headers onto the same fields', () => {
    const ix = autoMapColumns(HEADER)
    expect(ix.company).toBe(0)
    expect(ix.state).toBe(2)
    expect(ix.portfolio_size).toBe(5)
  })

  it('takes the highest-priority alias when a file has several', () => {
    // pms_f outranks pms — the fingerprinted value is the better one.
    expect(autoMapColumns(['pms', 'pms_f']).pms).toBe(1)
  })

  it('leaves a field unmapped when no header matches', () => {
    expect(autoMapColumns(['Company']).email).toBeUndefined()
  })
})

describe('mapRow', () => {
  const ix = autoMapColumns(HEADER)

  it('normalizes as it maps', () => {
    const { upsert: row, warnings } = mapRow(
      ['Acme Rentals', 'Knoxville', 'tennessee', 'acme.com/', 'Streamline (ownerx.streamlinevrs.com)',
       '40-50', 'Jane@Acme.com', '(865) 555-0142'],
      ix, 2,
    )
    expect(warnings).toEqual([])
    expect(row).toMatchObject({
      company:        'Acme Rentals',
      state:          'TN',
      website:        'https://acme.com',
      domain:         'acme.com',
      pms:            'Streamline',
      pms_note:       'ownerx.streamlinevrs.com',
      portfolio_size: 45,
      email:          'jane@acme.com',
      phone:          '+18655550142',
    })
  })

  it('keeps the raw door-count cell alongside the parsed number', () => {
    const { upsert: row } = mapRow(
      ['Acme', '', '', '', '', '6 private cabins (Dall, Loon, Moose)', '', ''], ix, 2,
    )
    expect(row?.portfolio_size).toBe(6)
    expect(row?.portfolio_size_method).toBe('6 private cabins (Dall, Loon, Moose)')
  })

  it('skips a row with no company name and says which line', () => {
    const out = mapRow(['', 'Knoxville', 'TN', '', '', '', '', ''], ix, 7)
    expect(out.upsert).toBeNull()
    expect(out.line).toBe(7)
    expect(out.warnings[0]).toMatch(/No company name/)
  })

  it('warns and blanks an unusable email rather than storing it', () => {
    const out = mapRow(['Acme', '', '', '', '', '', 'jane at acme.com', ''], ix, 3)
    expect(out.upsert?.email).toBeNull()
    expect(out.warnings[0]).toMatch(/not a valid address/)
  })

  it('warns and blanks a website that is not a usable link', () => {
    const out = mapRow(['Acme', '', '', 'javascript:alert(1)', '', '', '', ''], ix, 4)
    expect(out.upsert?.website).toBeNull()
    expect(out.warnings[0]).toMatch(/not a usable http/)
  })

  it('falls back to the raw state rather than dropping the only location it has', () => {
    const out = mapRow(['Acme', '', 'Tenn.', '', '', '', '', ''], ix, 2)
    expect(out.upsert?.state).toBe('Tenn.')
  })

  it('keeps an unparseable phone as text', () => {
    const out = mapRow(['Acme', '', '', '', '', '', '', 'call the office'], ix, 2)
    expect(out.upsert?.phone).toBe('call the office')
  })

  it('numbers lines from the file, not the data rows', () => {
    const rows = mapRows([['A', '', '', '', '', '', '', ''], ['B', '', '', '', '', '', '', '']], ix)
    expect(rows.map((r) => r.line)).toEqual([2, 3])
  })
})

describe('keysOf', () => {
  it('answers to both its domain and its name key', () => {
    expect(keysOf({ company: 'Acme', domain: 'acme.com', city: 'Knoxville', state: 'TN' }))
      .toEqual(['domain:acme.com', 'name:acme|knoxville|tn'])
  })

  it('ignores case, punctuation and a legal suffix in the name key', () => {
    const a = keysOf({ company: 'The Acme Rentals, LLC', domain: null, city: 'Knoxville', state: 'TN' })
    const b = keysOf({ company: 'acme rentals', domain: null, city: 'knoxville', state: 'tn' })
    expect(a).toEqual(b)
  })

  it('keeps the same name in two cities distinct', () => {
    const orlando = keysOf({ company: 'Blue Gems', domain: null, city: 'Orlando', state: 'FL' })
    const vero    = keysOf({ company: 'Blue Gems', domain: null, city: 'Vero Beach', state: 'FL' })
    expect(orlando).not.toEqual(vero)
  })
})

describe('dedupe', () => {
  it('merges two rows for one company and fills blanks from the later one', () => {
    const { rows, merged } = dedupe([
      upsert({ company: 'Acme', city: 'Knoxville', state: 'TN' }),
      upsert({ company: 'Acme, LLC', city: 'Knoxville', state: 'TN', email: 'jane@acme.com' }),
    ])
    expect(merged).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('jane@acme.com')
  })

  it('matches across identities: a row with a domain and one without', () => {
    const { rows } = dedupe([
      upsert({ company: 'Acme', city: 'Knoxville', state: 'TN' }),
      upsert({ company: 'Acme', city: 'Knoxville', state: 'TN', domain: 'acme.com' }),
    ])
    expect(rows).toHaveLength(1)
    // The merged row gained the domain, so it now answers to that key too.
    expect(rows[0].domain).toBe('acme.com')
  })

  it('keeps genuinely different companies apart', () => {
    const { rows, merged } = dedupe([
      upsert({ company: 'Elite Vacation Rentals', city: 'Chandler', state: 'AZ' }),
      upsert({ company: 'Elite Vacation Rentals', city: 'Orange Beach', state: 'AL' }),
    ])
    expect(merged).toBe(0)
    expect(rows).toHaveLength(2)
  })
})

describe('buildPlan', () => {
  it('refreshes a scorer column on an existing row', () => {
    const plan = buildPlan(
      [upsert({ company: 'Acme', city: 'Knoxville', state: 'TN', pms: 'Streamline', score_a: 9 })],
      [existing({ id: 'a1', company: 'Acme', city: 'Knoxville', state: 'TN' })],
    )
    expect(plan.inserts).toHaveLength(0)
    expect(plan.updates).toEqual([
      { id: 'a1', patch: expect.objectContaining({ pms: 'Streamline', score_a: 9 }) },
    ])
  })

  it('never overwrites a contact a human already typed', () => {
    const plan = buildPlan(
      [upsert({ company: 'Acme', city: 'Knoxville', state: 'TN', email: 'sheet@acme.com', phone: '+18655550142' })],
      [existing({ id: 'a1', company: 'Acme', city: 'Knoxville', state: 'TN', email: 'human@acme.com' })],
    )
    const patch = plan.updates[0].patch
    expect(patch.email).toBeUndefined()      // already set by a person
    expect(patch.phone).toBe('+18655550142') // was empty, so filled
  })

  it('never writes a funnel column', () => {
    const plan = buildPlan(
      [upsert({ company: 'Acme', city: 'Knoxville', state: 'TN', pms: 'Track' })],
      [existing({ id: 'a1', company: 'Acme', city: 'Knoxville', state: 'TN' })],
    )
    for (const forbidden of ['status', 'status_note', 'notes', 'next_action_at', 'last_touch_at']) {
      expect(plan.updates[0].patch).not.toHaveProperty(forbidden)
    }
  })

  it('counts a matched row with nothing new as untouched, not as an update', () => {
    // Every value the file carries is already stored, so there is nothing to
    // write — not an update that rewrites city and state over themselves.
    const plan = buildPlan(
      [upsert({ company: 'Acme', city: 'Knoxville', state: 'TN' })],
      [existing({ id: 'a1', company: 'Acme', city: 'Knoxville', state: 'TN' })],
    )
    expect(plan.updates).toHaveLength(0)
    expect(plan.inserts).toHaveLength(0)
    expect(plan.untouched).toBe(1)
  })

  it('matches a domain-only file row against a name-only database row', () => {
    // The live bug: 1,645 rows carry no domain, the sheet supplies one for
    // 1,801. A single-key matcher inserts a duplicate here.
    const plan = buildPlan(
      [upsert({ company: 'Acme', city: 'Knoxville', state: 'TN', domain: 'acme.com', pms: 'Track' })],
      [existing({ id: 'a1', company: 'Acme', city: 'Knoxville', state: 'TN', domain: null })],
    )
    expect(plan.inserts).toHaveLength(0)
    expect(plan.updates[0].id).toBe('a1')
    expect(plan.updates[0].patch.domain).toBe('acme.com')
  })

  it('inserts a company the database has never seen', () => {
    const plan = buildPlan([upsert({ company: 'Brand New', state: 'TN' })], [])
    expect(plan.inserts).toHaveLength(1)
    expect(plan.updates).toHaveLength(0)
  })

  it('drops a duplicate domain claim rather than failing the whole chunk', () => {
    const plan = buildPlan(
      [
        upsert({ company: 'Parent Brand', city: 'Knoxville', state: 'TN', domain: 'shared.com' }),
        upsert({ company: 'Sub Brand',    city: 'Gatlinburg', state: 'TN', domain: 'shared.com' }),
      ],
      [],
    )
    expect(plan.inserts).toHaveLength(2)
    expect(plan.inserts.filter((r) => r.domain === 'shared.com')).toHaveLength(1)
    expect(plan.droppedDomains).toBe(1)
  })

  it('treats a shared domain as the stronger identity than a shared name', () => {
    // A file row claiming a domain another company already holds resolves to
    // THAT company — domain is the strongest key — rather than duplicating it
    // onto the same-named row.
    const plan = buildPlan(
      [upsert({ company: 'Acme', city: 'Knoxville', state: 'TN', domain: 'taken.com', score_a: 9 })],
      [
        existing({ id: 'a1', company: 'Acme',  city: 'Knoxville', state: 'TN', domain: null }),
        existing({ id: 'b2', company: 'Other', city: 'Nashville', state: 'TN', domain: 'taken.com' }),
      ],
    )
    expect(plan.inserts).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].id).toBe('b2')
    expect(plan.updates[0].patch).toMatchObject({ score_a: 9 })
  })

  it('matches a stored domain that was never normalized', () => {
    const plan = buildPlan(
      [upsert({ company: 'Totally Different Name', domain: 'acme.com', score_a: 9 })],
      [existing({ id: 'a1', company: 'Acme', domain: 'https://WWW.Acme.com/' })],
    )
    expect(plan.inserts).toHaveLength(0)
    expect(plan.updates[0].id).toBe('a1')
  })

  it('skips a scorer column whose stored value already matches the file', () => {
    const plan = buildPlan(
      [upsert({ company: 'Acme', city: 'Knoxville', state: 'TN', pms: 'Track', score_a: 9 })],
      [existing({ id: 'a1', company: 'Acme', city: 'Knoxville', state: 'TN', pms: 'Track', score_a: 4 })],
    )
    expect(plan.updates[0].patch).toEqual({ score_a: 9 })
  })

  it('fills a missing domain but never replaces one already stored', () => {
    const plan = buildPlan(
      [upsert({ company: 'Acme', city: 'Knoxville', state: 'TN', domain: 'new.com' })],
      [existing({ id: 'a1', company: 'Acme', city: 'Knoxville', state: 'TN', domain: 'kept.com' })],
    )
    expect(plan.updates).toHaveLength(0)
    expect(plan.untouched).toBe(1)
  })
})
