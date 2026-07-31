import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Structural backstop for the B4c class of defect (pre-launch audit
// 2026-07-30):
//
//   const updatePayload = {
//     is_completed: payload.is_completed,
//     completed_at: payload.completed_at ?? null,   // ← writes an explicit
//   }                                               //   NULL when the
//                                                   //   mutation never
//                                                   //   carried the field
//
// photo-sync enqueues a checklist_instance_items PATCH carrying ONLY
// photo_storage_path. `is_completed: undefined` is dropped by JSON
// serialization and is therefore harmless; `completed_at: undefined ?? null`
// becomes a real NULL, wiping the completion timestamp off an item that is
// still is_completed = true — the exact timestamp checklist duration
// tracking and assignment_outcomes are computed from. It failed silently:
// the write succeeded, so nothing retried and nothing logged.
//
// The rule: inside a Supabase upload builder, a field may only be assigned
// from `payload.<x>` behind an explicit `'<x>' in payload` presence check.
// A mutation that didn't carry a field must leave that column alone.

const ROOT = join(__dirname, '..', '..')

/** Files whose exported functions build Supabase update payloads from outbox mutations. */
const UPLOAD_BUILDER_FILES = [
  'lib/dexie/syncService.ts',
  'lib/dexie/photo-sync.ts',
]

// Fresh instances every call — a shared /g regex carries `lastIndex`
// between matchAll() calls and would silently skip matches.
// Matches a payload field being written INTO an update payload, in either
// style this codebase uses:
//   object literal:  `completed_at: payload.completed_at ?? null`
//   statement:       `updatePayload.crew_notes = payload.crew_notes`
// (the statement form is usually a guarded one-liner, so this is not
// anchored to the start of a line). The written field is group 3.
const ASSIGNMENT_PATTERN = (): RegExp => /(?:(\w+):|\w+\.(\w+)\s*=)\s*payload\.(\w+)/g

/**
 * A payload field is considered guarded when the file contains an explicit
 * `'field' in payload` presence check for it. Deliberately file-scoped
 * rather than block-scoped: every builder in these files is a small,
 * single-purpose function, and requiring the check to exist at all is what
 * closes the class — a field with no `in payload` check anywhere is
 * unambiguously unguarded.
 */
function guardedFields(source: string): Set<string> {
  return new Set([...source.matchAll(/'(\w+)'\s+in\s+payload/g)].map((m) => m[1]!))
}

/**
 * Only Supabase UPDATE builders are in scope.
 *
 * - INSERT/UPSERT builders write a whole new row, so every column is
 *   deliberately present.
 * - Route-Handler builders (`fetch(..., { body: JSON.stringify({...}) })`)
 *   send a request body the server validates; an absent field there is a
 *   400, not a silent destructive NULL on an existing column.
 *
 * What's left is exactly the case the rule exists for: a partial UPDATE
 * against a live row.
 */
function updateBuilders(source: string): string {
  return source
    .split(/\n(?=async function |function )/)
    .filter((fn) => fn.includes('.update(') && !fn.includes('.upsert(') && !fn.includes('.insert('))
    .join('\n')
}

describe('guardrail: sync upload builders never write an unrequested NULL', () => {
  for (const file of UPLOAD_BUILDER_FILES) {
    it(`${file} gates every payload field on an "in payload" presence check`, () => {
      const source = readFileSync(join(ROOT, file), 'utf8')
      const scanned = updateBuilders(source)
      const guarded = guardedFields(source)

      const violations: string[] = []
      for (const match of scanned.matchAll(ASSIGNMENT_PATTERN())) {
        const payloadField = match[3]!
        if (!guarded.has(payloadField)) {
          violations.push(`${match[0]!.trim()}   (no "'${payloadField}' in payload" check)`)
        }
      }

      expect(violations, [
        `${file} assigns a Supabase update column straight from the mutation`,
        'payload with no presence check. A mutation that never carried that',
        'field will write undefined (silently dropped) or an explicit NULL',
        '(silently destructive — this is how every photo upload used to NULL',
        "checklist_instance_items.completed_at). Gate it on `'field' in payload`:",
        ...violations,
      ].join('\n')).toEqual([])
    })
  }

  it('the scan actually finds the guarded assignments it is meant to police', () => {
    // Guards the guardrail: if the regexes stop matching (a refactor changes
    // the builder style), the test above would pass vacuously.
    const source = readFileSync(join(ROOT, 'lib/dexie/syncService.ts'), 'utf8')
    expect(guardedFields(source).size, 'no "in payload" checks found — did the builder style change?').toBeGreaterThan(5)
    const found = [...updateBuilders(source).matchAll(ASSIGNMENT_PATTERN())]
    expect(
      found.length,
      'no payload-field assignments found in any UPDATE builder — the regexes or the builder style are stale',
    ).toBeGreaterThan(5)
  })
})
