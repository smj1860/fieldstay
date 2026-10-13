import { describe, it, expect } from 'vitest'
import { collectSourceFiles, read, blankComments, rel } from './scan'

// ============================================================================
// crew_availability became a THREE-state column in 20261013170000:
//
//   is_available = false              → the whole day is off
//   is_available = true, parts NULL   → available all day
//   is_available = true, parts [...]  → off only in those windows
//
// The dangerous reader is the one that survived the migration unchanged:
// `.eq('is_available', false)` still compiles, still returns rows, and now
// means "whole-day absences only". A crew member who marked their morning off
// carries is_available = TRUE, so that filter reads them as fully available
// and autopilot assigns them the 10am checkout the feature exists to prevent.
// Nothing fails, nothing logs; the exclusion just quietly stops covering half
// its cases.
//
// So: any read of crew_availability either resolves the three states through
// isUnavailableAt(), or is registered below with why it does not need to.
// ============================================================================

const AVAILABILITY_READ = /\.from\(\s*['"]crew_availability['"]\s*\)/g
const BOOLEAN_FILTER    = /\.eq\(\s*['"]is_available['"]\s*,\s*(?:true|false)\s*\)/
/** Either shared resolver. isUnavailableAt answers about an INSTANT, hasTimeOff about a DATE. */
const RESOLVER          = /isUnavailableAt\(|hasTimeOff\)|hasTimeOff\(/

/**
 * Reads that legitimately do not resolve the windows. Each states why, and a
 * new entry is a review event rather than a formality.
 */
const EXCEPTIONS: Record<string, string> = {
  'app/crew/availability/actions.ts':
    'The WRITE path. normaliseParts() produces the three states; it does not read them back.',
  'app/(dashboard)/maintenance/create-work-order-helpers.ts':
    'A work order carries a DATE and no time of day, so there is no instant to resolve a window against. Warning on a half-day absence would fire for an afternoon job because the crew member booked the morning off, which is a worse answer than staying whole-day-only. Revisit if work orders ever gain a scheduled TIME — vendor_scheduled_at exists but is the vendor appointment, not a crew one.',
}

/**
 * The `.select('…')` string that follows a `.from('crew_availability')`.
 *
 * Read from the SELECT ITSELF rather than from anywhere in the file, which is
 * the whole point: an interface that merely declares `unavailable_parts`, or
 * an import of the resolver that nothing calls, would otherwise wave a read
 * through. That is not hypothetical — this guardrail's first version did
 * exactly that and failed its own fire check.
 */
function selectAfterRead(code: string, readIndex: number): string | null {
  const tail  = code.slice(readIndex, readIndex + 400)
  const match = /\.select\(\s*(['"`])([\s\S]*?)\1/.exec(tail)
  return match ? match[2]! : null
}

interface Offence { path: string; why: string }

function offences(): Offence[] {
  const found: Offence[] = []

  for (const file of collectSourceFiles(['app', 'lib'])) {
    // blankComments(), not read(): this scanner walks the source by INDEX to
    // find the select that follows each read, so readCode() would shift every
    // offset. It is not cosmetic either — a commented-out query would
    // otherwise be reported as a live one.
    const code = blankComments(read(file))
    const path = rel(file)
    if (EXCEPTIONS[path]) continue

    AVAILABILITY_READ.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = AVAILABILITY_READ.exec(code))) {
      const selected = selectAfterRead(code, match.index)
      if (selected === null) continue

      if (!selected.includes('unavailable_parts')) {
        found.push({ path, why: 'select drops unavailable_parts, so a half-day row reads as available' })
      }
    }

    if (BOOLEAN_FILTER.test(code) && AVAILABILITY_READ.test(code) && !RESOLVER.test(code)) {
      found.push({ path, why: 'filters on is_available alone, which no longer means "has time off"' })
    }
  }

  return found
}

describe('guardrail: crew_availability reads are window-aware', () => {
  it('every read carries unavailable_parts, or is registered', () => {
    expect(offences().map((o) => `${o.path} — ${o.why}`).join('\n')).toEqual('')
  })

  // Self-checks. A scan that matches nothing passes for the wrong reason, and
  // "zero offences" looks identical whether the tree is clean or the regex is
  // broken. Both shapes are asserted to FIRE on a sample.
  it('fires on a select that drops the column', () => {
    const sample = `const r = await supabase
      .from('crew_availability')
      .select('crew_member_id')
      .eq('is_available', false)`
    AVAILABILITY_READ.lastIndex = 0
    const at = AVAILABILITY_READ.exec(sample)!.index
    expect(selectAfterRead(sample, at)).toBe('crew_member_id')
    expect(selectAfterRead(sample, at)!.includes('unavailable_parts')).toBe(false)
    expect(BOOLEAN_FILTER.test(sample)).toBe(true)
  })

  it('does not fire on a select that carries the column', () => {
    const sample = `const r = await supabase
      .from('crew_availability')
      .select('crew_member_id, is_available, unavailable_parts')`
    AVAILABILITY_READ.lastIndex = 0
    const at = AVAILABILITY_READ.exec(sample)!.index
    expect(selectAfterRead(sample, at)!.includes('unavailable_parts')).toBe(true)
  })

  // An IMPORT of the resolver is not a CALL of it. The first version of this
  // guardrail accepted the import and so passed its own sabotage test.
  it('does not accept a bare import as resolving', () => {
    expect(RESOLVER.test("import { isUnavailableAt } from '@/lib/scheduling/part-of-day'")).toBe(false)
    expect(RESOLVER.test('isUnavailableAt(row, when)')).toBe(true)
  })

  it('every registered exception still reads the table', () => {
    const stale = Object.keys(EXCEPTIONS).filter((path) => {
      AVAILABILITY_READ.lastIndex = 0
      return !AVAILABILITY_READ.test(read(path))
    })
    expect(stale.join('\n')).toEqual('')
  })
})
