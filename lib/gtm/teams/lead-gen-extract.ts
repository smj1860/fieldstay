import { normalizeEmail, normalizePhone } from '@/lib/prospecting/normalize'

/**
 * Public contact details, read off a company's own web pages.
 *
 * Deterministic on purpose: regular expressions and a JSON parse, no model and
 * no vendor. It finds what the company chose to publish (a mailto link, a tel
 * link, a structured-data block, a printed address) and says where each came
 * from, so the person approving can check the page instead of trusting a guess.
 *
 * Pure: it reads a string and returns candidates. Fetching is somewhere else.
 * Every pattern is bounded or index-scanned, because the input is a stranger's
 * HTML and a pattern that backtracks on it would hang the worker.
 */

export type EmailHow = 'mailto' | 'cloudflare' | 'json_ld' | 'text'
export type PhoneHow = 'tel' | 'json_ld' | 'text'

export interface EmailCandidate { email: string; how: EmailHow; sourceUrl: string }
export interface PhoneCandidate { e164: string; how: PhoneHow; sourceUrl: string }

export interface PageFindings {
  emails:       EmailCandidate[]
  phones:       PhoneCandidate[]
  contactLinks: string[]
}

// ── noise ───────────────────────────────────────────────────────────────────

/** Addresses that are never a person at the company: placeholders, platforms, and filenames that merely contain an @. */
const JUNK_DOMAINS = new Set([
  'example.com', 'domain.com', 'yourdomain.com', 'email.com', 'sentry.io', 'sentry-next.wixpress.com',
  'wixpress.com', 'godaddy.com', 'squarespace.com', 'wordpress.com', 'wp.com', 'shopify.com',
])
const JUNK_LOCALS = /^(no-?reply|do-?not-?reply|donotreply|privacy|abuse|postmaster|webmaster|unsubscribe|mailer-daemon|bounce|root|user|name|you|yourname|email)$/
const FILE_SUFFIX = /\.(png|jpe?g|gif|svg|webp|avif|css|js|woff2?|ttf|ico|pdf)$/i

export function isUsableEmail(raw: string): string | null {
  const email = normalizeEmail(raw)
  if (email === null) return null
  const at = email.lastIndexOf('@')
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (FILE_SUFFIX.test(domain) || /^\d+x$/.test(local)) return null
  if (JUNK_LOCALS.test(local)) return null
  return JUNK_DOMAINS.has(domain) ? null : email
}

// ── decoding ────────────────────────────────────────────────────────────────

/** Cloudflare's email protection: a hex string whose first byte is the XOR key for the rest. */
export function decodeCloudflareEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,200}$/i.test(hex) || hex.length % 2 !== 0) return null
  const key = Number.parseInt(hex.slice(0, 2), 16)
  let out = ''
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key)
  return out
}

const NAMED: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&lt;': '<', '&gt;': '>' }
const decodeEntities = (s: string): string => s.replace(/&(?:amp|quot|apos|nbsp|lt|gt|#39);/gi, (m) => NAMED[m.toLowerCase()] ?? m)

/** The earliest `<script` or `<style` at or after `from`, or null. */
function nextRawTextOpen(low: string, from: number): { at: number; tag: string } | null {
  const script = low.indexOf('<script', from)
  const style = low.indexOf('<style', from)
  if (script < 0 && style < 0) return null
  if (style < 0 || (script >= 0 && script < style)) return { at: script, tag: 'script' }
  return { at: style, tag: 'style' }
}

/** Drops <script> and <style> bodies by index scan: linear, no backtracking. */
function dropRawText(html: string): string {
  const low = html.toLowerCase()
  let out = ''
  let i = 0
  for (;;) {
    const open = nextRawTextOpen(low, i)
    if (!open) return out + html.slice(i)
    out += `${html.slice(i, open.at)} `
    const close = low.indexOf(`</${open.tag}`, open.at)
    const end = close < 0 ? -1 : low.indexOf('>', close)
    if (end < 0) return out
    i = end + 1
  }
}

function visibleText(html: string): string {
  return decodeEntities(dropRawText(html).replace(/<[^>]{0,2000}>/g, ' ')).replace(/\s+/g, ' ')
}

// ── structured data ─────────────────────────────────────────────────────────

const JSON_LD_BLOCK = /<script[^>]{0,300}application\/ld\+json[^>]{0,300}>([\s\S]{0,200000}?)<\/script>/gi
const MAX_JSON_DEPTH = 6

function collectJsonLd(node: unknown, depth: number, found: { emails: string[]; phones: string[] }): void {
  if (depth > MAX_JSON_DEPTH || typeof node !== 'object' || node === null) return
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 50)) collectJsonLd(item, depth + 1, found)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && key === 'email') found.emails.push(value)
    else if (typeof value === 'string' && key === 'telephone') found.phones.push(value)
    else collectJsonLd(value, depth + 1, found)
  }
}

function jsonLdContacts(html: string): { emails: string[]; phones: string[] } {
  const found = { emails: [] as string[], phones: [] as string[] }
  for (const match of html.matchAll(JSON_LD_BLOCK)) {
    try {
      collectJsonLd(JSON.parse(match[1]), 0, found)
    } catch {
      // A malformed block is the site's problem. Nothing to read from it.
    }
  }
  return found
}

// ── page extraction ─────────────────────────────────────────────────────────

const MAILTO = /href\s{0,5}=\s{0,5}["']mailto:([^"'?#\s]{1,254})/gi
const CF_EMAIL = /data-cfemail\s{0,5}=\s{0,5}["']([0-9a-f]{4,200})["']/gi
const TEL = /href\s{0,5}=\s{0,5}["']tel:([^"']{1,40})["']/gi
const TEXT_EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,5}/gi
const TEXT_PHONE = /(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}/g
const ANCHOR_HREF = /<a\s[^>]{0,500}?href\s{0,5}=\s{0,5}["']([^"'#]{1,300})["']/gi
const MAX_PER_KIND = 40

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, MAX_PER_KIND)
}

function emailsOf(html: string, sourceUrl: string): EmailCandidate[] {
  const out: EmailCandidate[] = []
  const add = (raw: string, how: EmailHow) => {
    const email = isUsableEmail(decodeEntities(raw))
    if (email) out.push({ email, how, sourceUrl })
  }
  for (const m of html.matchAll(MAILTO)) add(decodeURIComponent(m[1].replace(/%(?![0-9a-f]{2})/gi, '%25')), 'mailto')
  for (const m of html.matchAll(CF_EMAIL)) {
    const decoded = decodeCloudflareEmail(m[1])
    if (decoded) add(decoded, 'cloudflare')
  }
  for (const raw of jsonLdContacts(html).emails) add(raw, 'json_ld')
  for (const m of visibleText(html).matchAll(TEXT_EMAIL)) add(m[0], 'text')
  return dedupeBy(out, (c) => `${c.email}|${c.how}`)
}

function phonesOf(html: string, sourceUrl: string): PhoneCandidate[] {
  const out: PhoneCandidate[] = []
  const add = (raw: string, how: PhoneHow) => {
    const { e164 } = normalizePhone(raw)
    if (e164) out.push({ e164, how, sourceUrl })
  }
  for (const m of html.matchAll(TEL)) add(decodeEntities(m[1]), 'tel')
  for (const raw of jsonLdContacts(html).phones) add(raw, 'json_ld')
  for (const m of visibleText(html).matchAll(TEXT_PHONE)) add(m[0], 'text')
  return dedupeBy(out, (c) => `${c.e164}|${c.how}`)
}

/** Same-origin links that look like a contact page, best-first and capped. */
function contactLinksOf(html: string, baseUrl: string): string[] {
  let base: URL
  try { base = new URL(baseUrl) } catch { return [] }
  const links: string[] = []
  for (const m of html.matchAll(ANCHOR_HREF)) {
    if (!/contact/i.test(m[1])) continue
    try {
      const url = new URL(decodeEntities(m[1]), base)
      if (url.origin === base.origin && url.protocol === 'https:') links.push(`${url.origin}${url.pathname}`)
    } catch {
      // An href that is not a URL is not a link to follow.
    }
  }
  return [...new Set(links)].slice(0, 5)
}

export function extractFromPage(html: string, sourceUrl: string): PageFindings {
  return {
    emails:       emailsOf(html, sourceUrl),
    phones:       phonesOf(html, sourceUrl),
    contactLinks: contactLinksOf(html, sourceUrl),
  }
}

// ── choosing ────────────────────────────────────────────────────────────────

const stripWww = (host: string): string => host.replace(/^www\./, '').toLowerCase()

export function siteDomainOf(siteUrl: string): string | null {
  try { return stripWww(new URL(siteUrl).hostname) } catch { return null }
}

function isOnDomain(email: string, siteDomain: string | null): boolean {
  if (siteDomain === null) return false
  const domain = email.slice(email.lastIndexOf('@') + 1)
  return domain === siteDomain || domain.endsWith(`.${siteDomain}`)
}

/**
 * An address must earn its place. Being on the company's own domain is the
 * strongest signal; being a deliberate link (mailto, protected, structured data)
 * is next; being printed on more than one page adds a little. A bare address in
 * body text on someone else's domain scores 1 and is dropped, because that is
 * what a widget vendor's support address looks like. Deterministic: ties break
 * alphabetically.
 */
export const MIN_EMAIL_SCORE = 2

export interface RankedEmail { email: string; score: number; sources: EmailCandidate[] }

export function rankEmails(candidates: readonly EmailCandidate[], siteDomain: string | null): RankedEmail[] {
  const byEmail = new Map<string, EmailCandidate[]>()
  for (const c of candidates) byEmail.set(c.email, [...(byEmail.get(c.email) ?? []), c])

  const ranked = [...byEmail.entries()].map(([email, sources]) => {
    const deliberate = sources.some((s) => s.how !== 'text')
    const pages = new Set(sources.map((s) => s.sourceUrl)).size
    const score = (isOnDomain(email, siteDomain) ? 4 : 0) + (deliberate ? 2 : 0) + Math.min(pages - 1, 2)
    return { email, score, sources }
  })
  return ranked
    .filter((r) => r.score >= MIN_EMAIL_SCORE)
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email))
}

const PHONE_HOW_RANK: Record<PhoneHow, number> = { tel: 3, json_ld: 2, text: 1 }

export interface RankedPhone { e164: string; sources: PhoneCandidate[] }

export function rankPhones(candidates: readonly PhoneCandidate[]): RankedPhone[] {
  const byPhone = new Map<string, PhoneCandidate[]>()
  for (const c of candidates) byPhone.set(c.e164, [...(byPhone.get(c.e164) ?? []), c])
  const strength = (sources: PhoneCandidate[]) =>
    Math.max(...sources.map((s) => PHONE_HOW_RANK[s.how])) * 10 + sources.length
  return [...byPhone.entries()]
    .map(([e164, sources]) => ({ e164, sources }))
    .sort((a, b) => strength(b.sources) - strength(a.sources) || a.e164.localeCompare(b.e164))
}
