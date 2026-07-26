import 'server-only'
import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Roadshow demo configuration and the entry gate shared by /demo/* routes.
 *
 * The demo org is an ordinary tenant (see 20260726160000_demo_org_support.sql)
 * — nothing here grants elevated access. What the secret protects is the
 * ability to MINT a session as the demo PM and to WIPE/RESEED the demo org,
 * both of which are destructive-but-scoped rather than privilege-escalating.
 */

/** Slug of the demo organization. Seeded by lib/demo/seed.ts. */
export const DEMO_ORG_SLUG = 'roadshow-demo'

/**
 * Whether the demo surface is configured at all. False in any environment
 * without DEMO_ENTRY_SECRET (CI, preview deploys, a contributor's local env),
 * which makes /demo/* return 404 there rather than half-working.
 */
export function isDemoSurfaceEnabled(): boolean {
  const secret = process.env.DEMO_ENTRY_SECRET
  return typeof secret === 'string' && secret.length > 0
}

/**
 * Constant-time check of a caller-supplied `?key=` against DEMO_ENTRY_SECRET.
 *
 * Both sides are SHA-256'd first so the comparison operands are always 32
 * bytes: timingSafeEqual throws on a length mismatch, and that throw would
 * itself leak the secret's length to anyone probing with varying-length keys.
 *
 * Fails CLOSED when the secret is unset — an unconfigured environment must
 * not be reachable by sending no key at all.
 */
export function demoSecretMatches(provided: string | null | undefined): boolean {
  const secret = process.env.DEMO_ENTRY_SECRET
  if (!secret || secret.length === 0) return false
  if (provided === null || provided === undefined || provided.length === 0) return false

  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}

/**
 * Minimum secret length enforced at seed time. 32 chars of a URL-safe random
 * string is the floor for something that lives in a QR code on a booth table
 * and is never rotated mid-event.
 */
export const DEMO_SECRET_MIN_LENGTH = 32
