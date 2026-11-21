import 'server-only'
import { LEAD_GEN_PAGE_TIMEOUT_MS, LEAD_GEN_ROBOTS_TIMEOUT_MS } from '@/lib/http/timeout'
import { safeFetch } from '@/lib/security/url-guard'
import { robotsAllows } from './robots'
import { extractFromPage, type PageFindings } from './lead-gen-extract'

/**
 * Reads a prospect's own website, politely.
 *
 * Polite means: identify ourselves, read robots.txt first and obey it, fetch at
 * most MAX_PAGES pages one at a time with a pause between, and never follow a
 * link off the site. Every request goes through safeFetch(), which refuses
 * private addresses and re-checks every redirect hop: the URL here came from a
 * database row an operator or a crawler wrote, so it is not trusted.
 */

export const LEAD_GEN_USER_AGENT = 'FieldStayResearchBot/0.1 (+https://fieldstay.app)'

/** Homepage plus at most two more. Enough to find a contact page, not enough to be a crawl. */
export const MAX_PAGES = 3

/** Where to look for a contact page when the homepage does not link one. */
const FALLBACK_PATHS = ['/contact', '/contact-us']

const PAUSE_MS = 600
const MAX_BODY_CHARS = 600_000
const MAX_ROBOTS_CHARS = 100_000

export interface SitePage { url: string; findings: PageFindings }

export interface SiteResearch {
  pages:         SitePage[]
  /** the homepage itself is disallowed to us, so nothing was read */
  robotsBlocked: boolean
}

type RobotsResult = { kind: 'rules'; text: string } | { kind: 'none' }

async function readRobots(origin: string): Promise<RobotsResult> {
  const res = await safeFetch(`${origin}/robots.txt`, {
    headers: { 'User-Agent': LEAD_GEN_USER_AGENT, Accept: 'text/plain' },
    signal:  AbortSignal.timeout(LEAD_GEN_ROBOTS_TIMEOUT_MS),
  })
  // A server that is struggling is not a server that said yes. Come back later.
  if (res.status === 429 || res.status >= 500) throw new Error(`robots.txt unavailable (HTTP ${res.status})`)
  if (!res.ok) return { kind: 'none' }
  return { kind: 'rules', text: (await res.text()).slice(0, MAX_ROBOTS_CHARS) }
}

type PageResult = { kind: 'page'; url: string; html: string } | { kind: 'skip' } | { kind: 'transient' }

async function readPage(url: string): Promise<PageResult> {
  const res = await safeFetch(url, {
    headers: { 'User-Agent': LEAD_GEN_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    signal:  AbortSignal.timeout(LEAD_GEN_PAGE_TIMEOUT_MS),
  })
  if (res.status === 429 || res.status >= 500) return { kind: 'transient' }
  if (!res.ok) return { kind: 'skip' }
  const type = res.headers.get('content-type') ?? ''
  if (type !== '' && !/html/i.test(type)) return { kind: 'skip' }
  return { kind: 'page', url, html: (await res.text()).slice(0, MAX_BODY_CHARS) }
}

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

function allowed(robots: RobotsResult, url: string): boolean {
  if (robots.kind === 'none') return true
  return robotsAllows(robots.text, new URL(url).pathname || '/', LEAD_GEN_USER_AGENT)
}

/** The next pages worth reading after the homepage: its own contact links, else the usual paths. */
function followUps(origin: string, homepage: PageFindings): string[] {
  const linked = homepage.contactLinks
  return (linked.length > 0 ? linked : FALLBACK_PATHS.map((p) => `${origin}${p}`)).slice(0, MAX_PAGES - 1)
}

export async function researchSite(siteUrl: string): Promise<SiteResearch> {
  const origin = new URL(siteUrl).origin
  const robots = await readRobots(origin)
  const home = `${origin}/`

  if (!allowed(robots, home)) return { pages: [], robotsBlocked: true }

  const pages: SitePage[] = []
  let transient = 0

  const homepage = await readPage(home)
  if (homepage.kind === 'transient') transient += 1
  if (homepage.kind === 'page') pages.push({ url: homepage.url, findings: extractFromPage(homepage.html, homepage.url) })

  const next = pages.length > 0 ? followUps(origin, pages[0].findings) : FALLBACK_PATHS.map((p) => `${origin}${p}`)
  for (const url of next) {
    if (!allowed(robots, url)) continue
    await pause(PAUSE_MS)
    const result = await readPage(url)
    if (result.kind === 'transient') transient += 1
    if (result.kind === 'page') pages.push({ url: result.url, findings: extractFromPage(result.html, result.url) })
  }

  // Nothing readable AND the site was struggling: that is a reason to retry,
  // not a finding that the company publishes no contact details.
  if (pages.length === 0 && transient > 0) throw new Error('Site unavailable (server error or rate limit)')
  return { pages, robotsBlocked: false }
}
