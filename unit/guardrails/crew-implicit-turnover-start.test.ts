import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { ROOT, readCode, stripComments as readCodeString } from './scan'

/**
 * A crew member who opens the checklist and starts ticking never taps "Start
 * Turnover". Before Phase C the turnover then sat at `assigned` for the whole
 * clean: the PM's board showed nothing happening while the work was visibly
 * under way, and `turnovers.started_at` — which the duration half of the crew
 * scoring loop reads — was never written at all.
 *
 * The fix infers the start from the first tick. The hazard is that there are
 * FOUR paths that can complete a checklist item (the toggle, asset capture,
 * photo capture, and a note saved against an already-ticked item), so the
 * inference has to live in ONE funnel rather than at four call sites. A fifth
 * path added later, or one of the four quietly reverted to calling the raw
 * helper, puts the hole straight back with nothing failing: the tick still
 * works, the checklist still completes, and only the turnover's status and
 * its start timestamp are wrong.
 *
 * So this asserts the funnel is the only caller. It is a text scan over code
 * with comments stripped (`readCode`), because the raw source names the
 * helper in prose several times, including in this file's own explanation.
 */

const HOOK = 'app/crew/turnovers/[id]/use-turnover-actions.ts'

/** The one function allowed to call the raw helper. */
const FUNNEL = 'writeChecklistItem'

function hookCode(): string {
  return readCode(join(ROOT, HOOK))
}

describe('guardrail: the implicit turnover start cannot be bypassed', () => {
  it('routes every checklist-item write through the single funnel', () => {
    const code = hookCode()
    const direct = [...code.matchAll(/updateChecklistItem\s*\(/g)]

    expect(
      direct.length,
      `${HOOK} calls updateChecklistItem() ${direct.length} times. Exactly one is \n`
      + `allowed: the ${FUNNEL}() funnel, which is what also starts the turnover on \n`
      + 'the first completed tick. A second caller is a completion path that silently \n'
      + 'leaves the turnover at `assigned` and never writes started_at.',
    ).toBe(1)
  })

  it('that one call is inside the funnel, and the funnel starts the turnover', () => {
    const code = hookCode()

    const funnelIdx = code.indexOf(`const ${FUNNEL} =`)
    expect(funnelIdx, `${FUNNEL}() is gone from ${HOOK}. If it was renamed, re-point this guardrail.`)
      .toBeGreaterThan(-1)

    const callIdx = code.indexOf('updateChecklistItem(', funnelIdx)
    expect(callIdx, 'The surviving updateChecklistItem() call is not inside the funnel.')
      .toBeGreaterThan(funnelIdx)

    // The funnel must actually do the thing it exists for, and only for a
    // COMPLETION: un-ticking an item is not a start.
    const body = code.slice(funnelIdx, funnelIdx + 600)
    expect(body, `${FUNNEL}() no longer calls ensureTurnoverStarted().`)
      .toMatch(/if\s*\(\s*input\.isCompleted\s*\)[\s\S]{0,60}ensureTurnoverStarted/)
  })

  it('only starts from `assigned`, so it cannot reopen a finished turnover', () => {
    const code = hookCode()
    const idx = code.indexOf('const ensureTurnoverStarted')
    expect(idx, 'ensureTurnoverStarted() is gone. Re-point this guardrail.').toBeGreaterThan(-1)

    const body = code.slice(idx, idx + 900)
    expect(body, 'The status gate is gone: a tick on a completed turnover would restart it.')
      .toContain("'assigned'")
    expect(body, 'The cancelled gate is gone: ticking on a cancelled turnover would start it.')
      .toContain('isCancelled')
  })

  // A guardrail that reports zero because it is broken looks exactly like one
  // reporting zero because the tree is clean. These run the real scan over
  // built fixtures, so a change that blinds it fails here rather than going
  // quiet.
  describe('fire check', () => {
    const countCalls = (src: string) => [...readCodeString(src).matchAll(/updateChecklistItem\s*\(/g)].length

    it('catches a second raw call', () => {
      expect(countCalls('const writeChecklistItem = () => updateChecklistItem(a)\nconst sneaky = () => updateChecklistItem(b)\n')).toBe(2)
    })

    it('accepts the single-funnel shape', () => {
      expect(countCalls('const writeChecklistItem = () => updateChecklistItem(a)\n')).toBe(1)
    })

    it('does not count a call named only in a comment', () => {
      expect(countCalls(
        'const writeChecklistItem = () => updateChecklistItem(a)\n'
        + '// never call updateChecklistItem( directly, use the funnel\n'
        + '/* updateChecklistItem( is off limits here */\n',
      )).toBe(1)
    })
  })
})
