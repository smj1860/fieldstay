import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read, readCode, blankComments } from './scan'

// ============================================================================
// CLAUDE.md → Styling Conventions: customer-facing copy uses commas and
// periods, never an em dash.
//
// This is a house-voice rule, not a correctness one, and it is here because a
// voice rule is exactly the kind that erodes silently: one dash lands in a new
// marketing paragraph, nobody notices, and six months later the copy has to be
// swept by hand again. It was, on 2026-09-29, across 243 files.
//
// ── What counts as customer-facing ─────────────────────────────────────────
//
// Everything a PM, a crew member, a vendor, a property owner or a guest can
// read: marketing and legal pages, the dashboard, the crew PWA, the owner and
// vendor portals, transactional email, SMS, in-app notifications, the FAQ, and
// inspection prompts. SCOPED_DIRS below is that surface.
//
// `app/admin/**` is deliberately NOT in scope. It is FieldStay staff tooling,
// no customer ever opens it, and sweeping it would mean maintaining a baseline
// for prose nobody outside the company reads. If that ever ships to customers,
// add it here and clean it in the same change.
//
// `lib/inspections/forms/index.ts` is out for the same kind of reason: its
// `why:` fields are a developer-facing registry of why two form items share a
// concern key, read by nobody at runtime. The three FORM files beside it
// (safety/indoor/outdoor/shared-sections), whose `prompt:` strings a crew
// member reads on a phone, ARE in scope.
//
// ── What an em dash is allowed to be ───────────────────────────────────────
//
// Two things, and they are not copy:
//
//   1. A STANDALONE PLACEHOLDER GLYPH — the dash rendered in a table cell or
//      an input when there is no value (`{value ?? '—'}`, `placeholder="—"`).
//      It carries no wording, so there is no comma or period to replace it
//      with, and blanking it would turn "not counted yet" into "empty field".
//      Matched structurally by PLACEHOLDER, not allowlisted, because a new one
//      is legitimate.
//
//   2. Anything in EXCEPTIONS below: today, two regex character classes that
//      normalize separator punctuation out of an imported CSV cell. That is
//      code operating ON an em dash, not copy containing one.
//
// EXCEPTIONS is keyed on `path:line` and shrink-only, same model as
// tailwind-color-ratchet. Never add a line of prose to it — fix the prose.
//
// ── Why readCode, and why blankComments too ────────────────────────────────
//
// readCode() strips comments, so this file's own header does not report
// itself and a dash in a JSDoc block is not a finding: a comment is not copy.
// But readCode SHIFTS every offset left, which would break the `path:line`
// keys EXCEPTIONS is written in. So the line numbers come from
// blankComments(), which blanks the same text in place. Both come from the
// one shared lexer in scan.ts, per CLAUDE.md's "do not hand-roll a third".
// ============================================================================

const SCOPED_DIRS = [
  'app',
  'components',
  'emails',
  'lib/resend',
  'lib/sms',
  'lib/crew',
  'lib/guidebook',
  'lib/inspections/forms',
]

const SCOPED_FILES = [
  'lib/faq-content.ts',
  'lib/notifications.ts',
]

/** Out of scope, by path prefix. See the header for why each one is here. */
const OUT_OF_SCOPE = [
  'app/admin/',
  'lib/inspections/forms/index.ts',
]

/**
 * An em dash that is the ENTIRE value, rather than punctuation inside a
 * sentence: `'—'`, `"—"`, `` `—` ``, `{'—'}`, or a lone `—` JSX text node.
 */
const PLACEHOLDER = /(['"`])\s*—\s*\1|\{\s*(['"`])\s*—\s*\2\s*\}|>\s*—\s*</g

/** Non-copy uses, `path:line`. Shrink-only: fix the site, never add a line. */
const EXCEPTIONS = new Set<string>([
  // Strips separator punctuation out of a pasted CSV cell before parsing it.
  // The em dash is an INPUT here, not output.
  'app/(dashboard)/crew-manage/crew-manage-client.tsx:98',
  'app/(dashboard)/vendors/vendors-client.tsx:103',
])

function inScope(path: string): boolean {
  return !OUT_OF_SCOPE.some((prefix) => path.startsWith(prefix))
}

/** `path:line` for every em dash in this file that is neither comment nor placeholder. */
function findings(file: string): string[] {
  // Cheap reject before either lexer runs: most files have no em dash at all.
  if (!read(file).includes('—')) return []
  // Comments are not copy, so a file whose only dashes are in prose comments
  // drops out here — offsets shift, which is why the line numbers below come
  // from blankComments() instead.
  if (!readCode(file).includes('—')) return []

  const path = rel(file)
  return blankComments(read(file))
    .split('\n')
    .flatMap((line, i) => {
      const key = `${path}:${i + 1}`
      if (!line.replace(PLACEHOLDER, '').includes('—')) return []
      if (EXCEPTIONS.has(key)) return []
      return [key]
    })
}

describe('guardrail: no em dashes in customer-facing copy', () => {
  const files = [
    ...collectSourceFiles(SCOPED_DIRS),
    ...SCOPED_FILES.map((f) => `${process.cwd()}/${f}`),
  ].filter((f) => inScope(rel(f)))

  const offenders = files.flatMap(findings).sort()

  it('no scoped file uses an em dash in copy', () => {
    expect(
      offenders,
      'Em dash in customer-facing copy. Rewrite with a comma or a period ' +
      '(CLAUDE.md → Styling Conventions). A colon is fine for a "Label: detail" ' +
      'heading, and parentheses for an aside that already contains commas. ' +
      'A standalone placeholder glyph is allowed and needs no entry; never ' +
      'add a line of prose to EXCEPTIONS.'
    ).toEqual([])
  })

  it('every EXCEPTIONS entry still points at a real em dash (the ratchet tightens)', () => {
    // Without this the list rots: a fixed line keeps its entry, and the entry
    // then silently exempts whatever later occupies that line number.
    const stale = [...EXCEPTIONS].filter((key) => {
      const [path, line] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))]
      const file = files.find((f) => rel(f) === path)
      if (!file) return true
      return !(blankComments(read(file)).split('\n')[line - 1] ?? '').includes('—')
    }).sort()

    expect(
      stale,
      'These EXCEPTIONS entries no longer point at an em dash. Delete them ' +
      'so the exemption does not drift onto an unrelated line.'
    ).toEqual([])
  })

  it('fires on a real violation (a clean tree and a broken scanner look identical)', () => {
    const line = '<p>Priced per property, no tiers.</p>'
    expect(line.replace(PLACEHOLDER, '').includes('—')).toBe(false)
    expect('<p>Priced per property — no tiers.</p>'.replace(PLACEHOLDER, '').includes('—')).toBe(true)
    // ...and does NOT fire on either shape of placeholder glyph.
    expect("{row.name ?? '—'}".replace(PLACEHOLDER, '').includes('—')).toBe(false)
    expect('<td>—</td>'.replace(PLACEHOLDER, '').includes('—')).toBe(false)
  })
})
