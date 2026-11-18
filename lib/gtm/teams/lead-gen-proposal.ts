import type { JsonObject } from '../tasks'
import type { WorkOutcome } from '../worker'
import { rankEmails, rankPhones, siteDomainOf, type EmailCandidate, type PhoneCandidate } from './lead-gen-extract'
import type { SiteResearch } from './lead-gen-fetch'

/**
 * Turns what was read off a website into a proposal a person can check.
 *
 * Pure. The rule that matters is in here: only a field that is EMPTY on the
 * account is ever proposed. Whatever a person (or the importer) put there wins,
 * so a proposal can never be a request to overwrite someone's correction.
 */

export interface ProspectContactState { id: string; company: string; email: string | null; phone: string | null }

const MAX_ALTERNATIVES = 3

const labelOf: Record<EmailCandidate['how'] | PhoneCandidate['how'], string> = {
  mailto: 'a mailto link', cloudflare: 'a protected email link', json_ld: 'the page\'s structured data',
  text: 'text on the page', tel: 'a tel link',
}

function pathOf(url: string): string {
  try { return new URL(url).pathname || '/' } catch { return url }
}

function describeSource(how: EmailCandidate['how'] | PhoneCandidate['how'], url: string): string {
  return `${labelOf[how]} on ${pathOf(url)}`
}

export function buildEnrichmentOutcome(
  prospect: ProspectContactState,
  siteUrl: string,
  research: SiteResearch,
): WorkOutcome {
  const pagesRead = research.pages.map((p) => p.url)

  if (research.robotsBlocked) {
    return { kind: 'nothing', output: {
      reason: 'robots_disallowed',
      summary: 'The site\'s robots.txt does not allow automated reading, so nothing was read.',
      site: siteUrl,
    } }
  }

  const emails = rankEmails(research.pages.flatMap((p) => p.findings.emails), siteDomainOf(siteUrl))
  const phones = rankPhones(research.pages.flatMap((p) => p.findings.phones))

  const bestEmail = prospect.email ? null : (emails[0] ?? null)
  const bestPhone = prospect.phone ? null : (phones[0] ?? null)

  if (bestEmail === null && bestPhone === null) {
    return { kind: 'nothing', output: {
      reason: 'no_contact_found',
      summary: `Read ${pagesRead.length} page${pagesRead.length === 1 ? '' : 's'} on ${siteDomainOf(siteUrl) ?? siteUrl} and found no usable public contact details.`,
      pages_read: pagesRead,
    } }
  }

  const fields: JsonObject = {}
  const evidence: JsonObject[] = []
  const lines: string[] = []

  if (bestEmail) {
    fields.email = bestEmail.email
    const source = bestEmail.sources[0]
    evidence.push({ field: 'email', value: bestEmail.email, source_url: source.sourceUrl, how: source.how })
    lines.push(`Email: ${bestEmail.email}, from ${describeSource(source.how, source.sourceUrl)}.`)
  }
  if (bestPhone) {
    fields.phone = bestPhone.e164
    const source = bestPhone.sources[0]
    evidence.push({ field: 'phone', value: bestPhone.e164, source_url: source.sourceUrl, how: source.how })
    lines.push(`Phone: ${bestPhone.e164}, from ${describeSource(source.how, source.sourceUrl)}.`)
  }

  // Alternatives are for someone choosing an email. An account that already has
  // one is not choosing, so listing addresses beside it would only be noise.
  const others = prospect.email ? [] : emails.filter((e) => e.email !== bestEmail?.email).slice(0, MAX_ALTERNATIVES).map((e) => e.email)
  if (others.length > 0) lines.push(`Other addresses seen, not proposed: ${others.join(', ')}.`)

  return { kind: 'propose', output: {
    summary: [`Found on ${siteDomainOf(siteUrl) ?? siteUrl} for ${prospect.company}:`, ...lines,
      'Approving saves these into the empty fields only. Anything already on the account is left alone.'].join('\n'),
    fields,
    evidence,
    alternatives: { emails: others },
    pages_read: pagesRead,
  } }
}
