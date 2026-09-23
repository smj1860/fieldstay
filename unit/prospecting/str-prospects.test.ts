import { describe, it, expect } from 'vitest'
import {
  toProspectUpsert,
  planStrProspectSync,
  STRSCOUT_SOURCE,
  type StrProspectRow,
} from '@/lib/prospecting/str-prospects'
import type { ExistingRow, ProspectUpsert } from '@/lib/prospecting/import'

function strRow(over: Partial<StrProspectRow> = {}): StrProspectRow {
  return {
    dedupe_key: 'k1', name: 'Acme Rentals', kind: 'company',
    state: 'TN', city: 'Knoxville', website: '', domain: '',
    phone: '', email: '', property_count: 0, source: 'directory',
    last_seen: '2026-09-19', pms: '',
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

describe('toProspectUpsert', () => {
  it('turns the scraper’s empty strings into NULL, not into "has a value"', () => {
    // The scraper writes '' rather than NULL — 247 of its 252 ICP rows have
    // email = ''. Storing that would count as "already has an email" forever
    // and block the fill-only backfill from ever putting a real one there.
    const row = toProspectUpsert(strRow({ email: '', phone: '', website: '', pms: '' }))
    expect(row).toMatchObject({
      email: null, phone: null, website: null, domain: null, pms: null,
    })
  })

  it('maps a fully-populated row', () => {
    const row = toProspectUpsert(strRow({
      name: '  Acme Rentals, LLC ', state: 'tennessee', city: 'Knoxville',
      website: 'acme.com/', phone: '(865) 555-0142', email: 'Info@Acme.com',
      property_count: 42, pms: 'Streamline (ownerx.streamlinevrs.com)',
      source: 'registry',
    }))
    expect(row).toMatchObject({
      company:               'Acme Rentals, LLC',
      state:                 'TN',
      website:               'https://acme.com',
      domain:                'acme.com',
      phone:                 '+18655550142',
      email:                 'info@acme.com',
      portfolio_size:        42,
      portfolio_size_method: 'strscout:registry',
      pms:                   'Streamline',
      pms_note:              'ownerx.streamlinevrs.com',
    })
  })

  it('treats an unsized row as unknown rather than as zero doors', () => {
    const row = toProspectUpsert(strRow({ property_count: 0 }))
    expect(row?.portfolio_size).toBeNull()
    expect(row?.portfolio_size_method).toBeNull()
  })

  it('never invents scorer columns', () => {
    const row = toProspectUpsert(strRow({ property_count: 40 }))
    expect(row).toMatchObject({
      score_a: null, score_b: null, track: null, bucket: null, gate: null,
    })
  })

  it('skips a row with no usable name', () => {
    expect(toProspectUpsert(strRow({ name: '   ' }))).toBeNull()
  })
})

describe('planStrProspectSync', () => {
  const mapped = (over: Partial<StrProspectRow> = {}): ProspectUpsert => {
    const row = toProspectUpsert(strRow(over))
    if (row === null) throw new Error('fixture produced no row')
    return row
  }

  it('inserts a company the funnel has never seen, stamped as strscout', () => {
    const plan = planStrProspectSync([mapped({ name: 'Brand New Co' })], [])
    expect(plan.inserts).toHaveLength(1)
    expect(plan.inserts[0].source).toBe(STRSCOUT_SOURCE)
    expect(plan.updates).toHaveLength(0)
  })

  it('fills a blank column on an account that already exists', () => {
    const plan = planStrProspectSync(
      [mapped({ phone: '(865) 555-0142' })],
      [existing({ id: 'a1', company: 'Acme Rentals', city: 'Knoxville', state: 'TN' })],
    )
    expect(plan.inserts).toHaveLength(0)
    expect(plan.updates).toEqual([{ id: 'a1', patch: { phone: '+18655550142' } }])
  })

  it('NEVER overwrites a column the account already has', () => {
    // A directory scrape must not beat a comparent-derived door count, a PMS
    // someone confirmed, or a phone a person typed.
    const plan = planStrProspectSync(
      [mapped({ phone: '(865) 555-0142', property_count: 11, pms: 'Guesty', city: 'Knoxville' })],
      [existing({
        id: 'a1', company: 'Acme Rentals', city: 'Knoxville', state: 'TN',
        phone: '+18659999999', portfolio_size: 40, pms: 'Streamline',
      })],
    )
    expect(plan.updates).toHaveLength(0)
    expect(plan.untouched).toBe(1)
  })

  it('never labels a door count it did not supply', () => {
    // portfolio_size already set, portfolio_size_method empty: writing the
    // method alone would claim this scrape produced a count the crawler did.
    const plan = planStrProspectSync(
      [mapped({ property_count: 11, phone: '8655550142' })],
      [existing({
        id: 'a1', company: 'Acme Rentals', city: 'Knoxville', state: 'TN',
        portfolio_size: 40, portfolio_size_method: null,
      })],
    )
    expect(plan.updates[0].patch).not.toHaveProperty('portfolio_size_method')
    expect(plan.updates[0].patch).toEqual({ phone: '+18655550142' })
  })

  it('never attaches PMS evidence to a PMS it did not supply', () => {
    const plan = planStrProspectSync(
      [mapped({ pms: 'Streamline (ownerx.streamlinevrs.com)', phone: '8655550142' })],
      [existing({
        id: 'a1', company: 'Acme Rentals', city: 'Knoxville', state: 'TN',
        pms: 'Track', pms_note: null,
      })],
    )
    expect(plan.updates[0].patch).not.toHaveProperty('pms_note')
  })

  it('never rewrites source or the scorer columns on an existing account', () => {
    const plan = planStrProspectSync(
      [mapped({ phone: '(865) 555-0142' })],
      [existing({
        id: 'a1', company: 'Acme Rentals', city: 'Knoxville', state: 'TN',
        source: 'master-sheet', score_a: 9, track: 'A',
      })],
    )
    for (const forbidden of ['source', 'score_a', 'score_b', 'track', 'bucket', 'gate']) {
      expect(plan.updates[0].patch).not.toHaveProperty(forbidden)
    }
  })

  it('never touches the funnel columns a person owns', () => {
    const plan = planStrProspectSync(
      [mapped({ phone: '(865) 555-0142' })],
      [existing({ id: 'a1', company: 'Acme Rentals', city: 'Knoxville', state: 'TN' })],
    )
    for (const forbidden of [
      'status', 'status_note', 'notes', 'next_action_at', 'last_touch_at',
      'contact_name', 'contact_title', 'linkedin_url',
    ]) {
      expect(plan.updates[0].patch).not.toHaveProperty(forbidden)
    }
  })

  it('matches on domain even when the names differ', () => {
    const plan = planStrProspectSync(
      [mapped({ name: 'Acme Vacation Homes', website: 'acme.com', phone: '8655550142' })],
      [existing({ id: 'a1', company: 'Totally Different', domain: 'acme.com' })],
    )
    expect(plan.inserts).toHaveLength(0)
    expect(plan.updates[0].id).toBe('a1')
  })

  it('collapses two scraper rows for one company before planning', () => {
    const plan = planStrProspectSync(
      [
        mapped({ dedupe_key: 'k1', name: 'Acme Rentals' }),
        mapped({ dedupe_key: 'k2', name: 'Acme Rentals, LLC', phone: '8655550142' }),
      ],
      [],
    )
    expect(plan.inserts).toHaveLength(1)
    expect(plan.inserts[0].phone).toBe('+18655550142')
  })

  it('is a no-op on a second run', () => {
    const rows = [mapped({ phone: '(865) 555-0142', property_count: 30 })]
    const after = existing({
      id: 'a1', company: 'Acme Rentals', city: 'Knoxville', state: 'TN',
      phone: '+18655550142', portfolio_size: 30,
      portfolio_size_method: 'strscout:directory',
    })
    const plan = planStrProspectSync(rows, [after])
    expect(plan.inserts).toHaveLength(0)
    expect(plan.updates).toHaveLength(0)
    expect(plan.untouched).toBe(1)
  })
})
