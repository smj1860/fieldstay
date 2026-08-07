/**
 * The window the crew calendar can navigate to, and therefore the only window
 * a time-off write may target.
 *
 * These live in their own module rather than in ./actions.ts because that file
 * is `'use server'`, and a Server Actions module may only export ASYNC
 * FUNCTIONS. A runtime value exported from one does not fail type-checking —
 * it fails the Next.js compiler, and it fails it by reporting that the file's
 * *other* export (`saveCrewAvailability`) does not exist, because the whole
 * module fails to transform.
 *
 * `export type` / `export interface` are fine there and several action files
 * use them; they are erased before the compiler ever sees them. A `const` is
 * not. That distinction is what `unit/guardrails/use-server-exports.test.ts`
 * encodes.
 *
 * Both the page (which renders this range) and the action (which accepts it)
 * import from here, so the range shown and the range accepted cannot drift.
 */
export const LOOKBACK_DAYS  = 30
export const LOOKAHEAD_DAYS = 365
