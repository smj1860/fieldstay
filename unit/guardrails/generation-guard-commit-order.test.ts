import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// A generation-guarded async refresh must not write its shared bookkeeping
// before an `await`.
//
// lib/dexie/context.tsx has two of these — refreshChecklistSubscription and
// refreshAssetsSubscription. Both can be invoked concurrently by rapid-fire
// change events, and both use a generation token so a superseded call bails
// instead of clobbering a newer one's subscription. The token only works if
// every write to the shared `subscribed*` variable happens INSIDE the
// committed section: after the last supersede check, with no await between
// that check and the channel install.
//
// refreshChecklistSubscription satisfies that by construction — it has no
// await after its check. refreshAssetsSubscription grew a second await
// (syncPropertyAssets) with the bookkeeping write in front of it, and a
// superseded call returned having already overwritten it:
//
//   subscribed = [p1], channel covers [p1]
//   A: computes [p1,p2] → writes subscribed = [p1,p2] → awaits sync
//   B: computes [p1,p2] → sameSet vs [p1,p2] is now TRUE → returns early
//   A: resolves, sees it was superseded → returns without subscribing
//
// End state: the bookkeeping claims [p1,p2] while the live channel covers
// [p1] alone, and every later refresh short-circuits on sameSet — so p2's
// subscription is never installed. A co-crew member's asset capture on p2
// stops arriving live, degrading to the scope-gate pull on screen open. Quiet
// enough that nobody would connect the two.
//
// The rule is checkable as written: no `await` may appear after a
// `subscribed<X> = ` assignment inside these functions.
// ============================================================================

const FILE = 'lib/dexie/context.tsx'

/**
 * Strips comments before scanning.
 *
 * Without this the check reads its own documentation as code. The comment
 * explaining this very bug contains the line `subscribed = [p1]` and the words
 * "no await between", so the first version matched prose, failed on the FIXED
 * source, and — the direction that actually matters — would have let a real
 * `await` hide behind an earlier comment match. A source-scanning guardrail
 * that does not strip comments is checking the wrong text.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments, incl. JSDoc
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')  // line comments, sparing `https://`
}

/** Body of `async function <name>(...)`, brace-matched. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`)
  if (start === -1) throw new Error(`${name} not found in ${FILE} — rename? update this guardrail`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced braces reading ${name}`)
}

const REFRESH_FUNCTIONS = ['refreshChecklistSubscription', 'refreshAssetsSubscription']

describe('guardrail: generation-guarded refreshes commit bookkeeping after their last await', () => {
  const src = stripComments(readFileSync(join(process.cwd(), FILE), 'utf8'))

  it.each(REFRESH_FUNCTIONS)('%s writes its subscribed* state with no await after it', (name) => {
    const body = functionBody(src, name)

    // The assignment, not a comparison — `subscribedX = ` but not `===`/`!==`.
    const assignment = /\bsubscribed[A-Za-z]*\s*=[^=]/.exec(body)
    expect(assignment, `${name} has no subscribed* assignment — did it move?`).not.toBeNull()

    const afterAssignment = body.slice(assignment!.index)
    expect(
      /\bawait\b/.test(afterAssignment),
      `${name} awaits AFTER writing its shared subscribed* state. A call ` +
      'superseded during that await returns having already overwritten the ' +
      'bookkeeping, so it describes a set the live channel never subscribed ' +
      'to — and every later refresh then short-circuits on sameSet and never ' +
      'installs it. Move the assignment below the last supersede check, next ' +
      'to the channel install.',
    ).toBe(false)
  })

  // Guards the guard: brace-matching silently returning something tiny would
  // make the assertions above vacuous.
  it('actually reads the function bodies it claims to check', () => {
    for (const name of REFRESH_FUNCTIONS) {
      const body = functionBody(src, name)
      expect(body.length, `${name} body looks truncated`).toBeGreaterThan(200)
      expect(body).toContain('myGeneration')
    }
  })
})
