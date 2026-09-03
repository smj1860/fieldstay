/**
 * lib/guidebook/assignment-constants.ts
 *
 * Client-safe constants for per-property sponsor assignment — no imports, no
 * server-only code.
 *
 * Split out of lib/guidebook/resolve-property-sponsors.ts for the same reason
 * lib/sms/template-registry.ts was split out of lib/sms/templates.ts: the
 * resolver is `import 'server-only'` (it reads Supabase), and the assignment
 * UI is `'use client'`. A client component importing the resolver just to read
 * a number fails the BUILD, not the typecheck — tsc has nothing to say about
 * server-only, so it looks fine right up until `next build`.
 */

/** How many sponsors any single property may carry. */
export const MAX_SPONSORS_PER_PROPERTY = 4

/**
 * The org property count at or above which per-property assignment is offered
 * at all. Below it every sponsor appears on every property, which is both
 * correct and what happens naturally when no assignment rows exist.
 *
 * Deliberately a live property count rather than a plan name: `plan` is
 * display-only in this codebase and has never been a feature gate.
 */
export const ASSIGNMENT_MIN_PROPERTIES = 5
