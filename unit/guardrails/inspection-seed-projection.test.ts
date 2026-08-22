import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// EVERY FIELD ON A FORM DEFINITION REACHES THE DATABASE.
//
// This guardrail exists because the same defect shipped TWICE, and the existing
// seed test could not see either one.
//
//   `default_actions` — the `Dflt` column on all ~137 rows of §12's tables had
//   no column to land in. Caught only because writing the seed forced the
//   question.
//
//   `shown_when_asset` — the SECTION GATE. Present on the repo type, absent
//   from the schema, silently dropped by the seed. Production carried nine
//   outdoor sections with no gating at all, so every municipal-water property
//   would have been asked nine well questions, and the "ledger-backed, not
//   inspector-asserted" skip §12.3 argues for would have become precisely the
//   inspector-asserted N/A it was written to prevent.
//
//   (A second gate, `shown_when_property_field`, shipped alongside it and was
//   dropped hours later with `properties.hoa_name`: FieldStay never held HOA
//   membership and will not collect it, so gating on that column would have
//   deleted three real questions rather than conditioning them.)
//
// unit/inspections/form-definitions.test.ts asserts the DEFINITIONS — counts,
// keys, concern coherence — and never looks at the projection. That is its
// blind spot and it is exactly where both bugs lived: the definition was right,
// the database never heard about it.
//
// So: parse the repo's own types and require every field to be projected. A new
// field added to ItemDefinition or SectionDefinition fails here until the seed
// writes it, which is a compile-adjacent nudge at the moment the field is
// invented rather than a discovery months later.
// ============================================================================

const ROOT = join(__dirname, '..', '..')
const TYPES_SRC = readFileSync(join(ROOT, 'lib/inspections/forms/types.ts'), 'utf8')
const SEED_SRC  = readFileSync(join(ROOT, 'scripts/seed-inspection-forms.ts'), 'utf8')

/**
 * Fields that are STRUCTURE rather than data — they shape the rows the seed
 * writes instead of becoming a column on one. Each entry says how it reaches
 * the database, so "structural" cannot become a place to hide a dropped field.
 */
const STRUCTURAL: Readonly<Record<string, string>> = {
  key:      'the identity the upsert conflicts on',
  prompt:   'written directly in itemColumns',
  name:     'written directly in the section upsert',
  items:    'iterated by flattenForm into rows',
  sections: 'iterated by seedForm into section rows',
  children: 'flattened into rows carrying parent_item_id',
  repeats:  'flattened into rows carrying repeat_source_item_id',
  version:  'part of the form-level (key, version) upsert',
  description: 'written directly in the form upsert',
}

/** Field names declared on one exported interface in types.ts. */
function fieldsOf(interfaceName: string): string[] {
  const start = TYPES_SRC.indexOf(`export interface ${interfaceName} {`)
  expect(start, `${interfaceName} not found in types.ts`).toBeGreaterThan(-1)
  const body = TYPES_SRC.slice(start, TYPES_SRC.indexOf('\n}', start))

  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!)
}

describe('guardrail: every form-definition field is projected into the database', () => {
  it('parses real interfaces — a scan that found nothing would pass everything', () => {
    expect(fieldsOf('ItemDefinition').length).toBeGreaterThan(10)
    expect(fieldsOf('SectionDefinition').length).toBeGreaterThan(2)
  })

  for (const iface of ['ItemDefinition', 'SectionDefinition'] as const) {
    it(`${iface}: every field is either written by the seed or named structural`, () => {
      const missing = fieldsOf(iface).filter((field) => {
        if (field in STRUCTURAL) return false
        // The seed writes `column: d.field ?? null` / `s.field ?? null`, so the
        // field name appearing as a property read is what proves projection.
        return !new RegExp(`\\b[ds]\\.${field}\\b`).test(SEED_SRC)
      })

      expect(missing, [
        `These ${iface} fields are never read by scripts/seed-inspection-forms.ts,`,
        'so they exist in the repo and never reach the database. The renderer',
        'reads the DATABASE, so a dropped field is not a missing feature — it is',
        'a feature that looks present in review and is absent at runtime.',
        '',
        'Add the column, project it in the seed, and add it to types/database.ts.',
        'If it genuinely shapes rows rather than becoming one, add it to',
        'STRUCTURAL in this file with a note saying how it reaches the DB.',
        '',
        ...missing.map((m) => `  ${iface}.${m}`),
      ].join('\n')).toEqual([])
    })
  }

  it('the section gate specifically is projected, with an explicit null', () => {
    // Named rather than left to the generic scan above: this is the field that
    // was silently dropped, and an UPSERT makes the null explicit-ness
    // load-bearing. Omitting a key leaves the previous seed's value in place,
    // so a section that LOSES its gate would keep gating forever.
    expect(SEED_SRC, 'shown_when_asset is not projected').toContain('s.shown_when_asset')
    expect(
      /shown_when_asset:\s*s\.shown_when_asset\s*\?\?\s*null/.test(SEED_SRC),
      'shown_when_asset must be written as an explicit null when absent — on an ' +
      'upsert, omitting it keeps whatever the previous seed wrote',
    ).toBe(true)
  })

  it('STRUCTURAL entries still exist as fields, and each says how it reaches the DB', () => {
    // A stale exemption is worse than a missing one: it silently covers a field
    // that no longer exists while looking like considered coverage.
    const all = new Set([...fieldsOf('ItemDefinition'), ...fieldsOf('SectionDefinition'), ...fieldsOf('FormDefinition')])
    for (const [field, why] of Object.entries(STRUCTURAL)) {
      expect(all.has(field), `STRUCTURAL names "${field}", which no definition declares`).toBe(true)
      expect(why.length, `STRUCTURAL["${field}"] needs a real reason`).toBeGreaterThan(15)
    }
  })
})
