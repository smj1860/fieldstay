import { describe, it, expect } from 'vitest'
import { buildEnrichmentOutcome, type ProspectContactState } from '@/lib/gtm/teams/lead-gen-proposal'
import type { SiteResearch } from '@/lib/gtm/teams/lead-gen-fetch'

const SITE = 'https://acmerentals.com'
const prospect = (over: Partial<ProspectContactState> = {}): ProspectContactState =>
  ({ id: 'p1', company: 'Acme Rentals', email: null, phone: null, ...over })

const page = (emails: { email: string; how?: 'mailto' | 'text' }[], phones: { e164: string; how?: 'tel' | 'text' }[] = [], url = `${SITE}/`) => ({
  url,
  findings: {
    emails: emails.map((e) => ({ email: e.email, how: e.how ?? 'mailto', sourceUrl: url })),
    phones: phones.map((p) => ({ e164: p.e164, how: p.how ?? 'tel', sourceUrl: url })),
    contactLinks: [],
  },
})
const research = (pages: SiteResearch['pages'], robotsBlocked = false): SiteResearch => ({ pages, robotsBlocked })

function proposed(outcome: ReturnType<typeof buildEnrichmentOutcome>) {
  expect(outcome.kind).toBe('propose')
  return outcome.output as { summary: string; fields: Record<string, string>; evidence: Record<string, string>[]; alternatives: { emails: string[] } }
}

describe('buildEnrichmentOutcome', () => {
  it('proposes the best email and phone, each with the page it came from', () => {
    const out = proposed(buildEnrichmentOutcome(prospect(), SITE, research([page([{ email: 'dana@acmerentals.com' }], [{ e164: '+18655550142' }])])))
    expect(out.fields).toEqual({ email: 'dana@acmerentals.com', phone: '+18655550142' })
    expect(out.evidence).toEqual([
      { field: 'email', value: 'dana@acmerentals.com', source_url: `${SITE}/`, how: 'mailto' },
      { field: 'phone', value: '+18655550142', source_url: `${SITE}/`, how: 'tel' },
    ])
    expect(out.summary).toContain('Acme Rentals')
    expect(out.summary).toContain('empty fields only')
  })

  // The rule that keeps a proposal from ever being a request to overwrite a person's work.
  it('never proposes a field the account already has', () => {
    const out = proposed(buildEnrichmentOutcome(prospect({ email: 'mine@acmerentals.com' }), SITE,
      research([page([{ email: 'dana@acmerentals.com' }], [{ e164: '+18655550142' }])])))
    expect(out.fields).toEqual({ phone: '+18655550142' })
    expect(JSON.stringify(out)).not.toContain('dana@acmerentals.com')
  })

  it('lists other addresses it saw without proposing them', () => {
    const out = proposed(buildEnrichmentOutcome(prospect(), SITE,
      research([page([{ email: 'a@acmerentals.com' }, { email: 'b@acmerentals.com' }])])))
    expect(Object.keys(out.fields)).toEqual(['email'])
    expect(out.alternatives.emails).toEqual(['b@acmerentals.com'])
    expect(out.summary).toContain('Other addresses seen, not proposed: b@acmerentals.com')
  })

  it('closes as "nothing found" instead of asking a person to approve an empty proposal', () => {
    const out = buildEnrichmentOutcome(prospect(), SITE, research([page([], [])]))
    expect(out.kind).toBe('nothing')
    expect(out.output).toMatchObject({ reason: 'no_contact_found', pages_read: [`${SITE}/`] })
  })

  it('says so, and reads nothing, when robots.txt forbids it', () => {
    const out = buildEnrichmentOutcome(prospect(), SITE, research([], true))
    expect(out).toMatchObject({ kind: 'nothing', output: { reason: 'robots_disallowed' } })
  })

  it('treats an account that is missing nothing found as nothing to propose', () => {
    const out = buildEnrichmentOutcome(prospect({ email: 'a@b.com', phone: '+15550001111' }), SITE,
      research([page([{ email: 'dana@acmerentals.com' }], [{ e164: '+18655550142' }])]))
    expect(out.kind).toBe('nothing')
  })

  it('contains no em dash in the text a person reads', () => {
    const out = proposed(buildEnrichmentOutcome(prospect(), SITE, research([page([{ email: 'dana@acmerentals.com' }])])))
    expect(out.summary).not.toContain('—')
  })
})
