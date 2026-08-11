import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

// ============================================================================
// A Server Action that reads a form field the form does not render does NOT
// read null — it reads null and then applies its own fallback, silently
// overwriting whatever was in the database.
//
// This shipped TWICE for the same column. `properties.max_guests`:
//
//   saveDetails:        parseInt(formData.get('max_guests') as string) || 2
//   parsePropertyForm:  positiveIntField(formData.get('max_guests'), 2, MAX_GUESTS)
//
// Neither form had the input. So creating a property set max_guests to 2
// regardless of size, and every later save of the details step reset it to 2
// again — for the whole portfolio, with no error and nothing in the UI to
// suggest a value had been lost. It surfaced only because resolvePar() scales
// towels, dinnerware and K-cups by that column, and a six-bedroom lodge was
// being stocked for a couple.
//
// The pairs below are (Server Action file, form component). For each, every
// `formData.get('x')` in the action must have a matching `name="x"` in the
// form. The reverse direction (rendered but never read) is NOT checked here:
// it is inert, and some forms legitimately carry inputs consumed by client
// state rather than the action.
// ============================================================================

// `fn` names the function whose body is scanned. Scoping to it matters: an
// actions.ts file holds several actions posting from DIFFERENT forms (the
// property file also creates assets), so scanning the whole file compares one
// form against every field in it and reports nonsense.
const PAIRS: Array<{ action: string; fn: string; form: string; label: string }> = [
  {
    label:  'createProperty',
    action: 'app/(dashboard)/properties/actions.ts',
    fn:     'parsePropertyForm',
    form:   'app/(dashboard)/properties/new/new-property-form.tsx',
  },
  {
    label:  'saveDetails',
    action: 'app/(dashboard)/properties/[id]/setup/details/actions.ts',
    fn:     'saveDetails',
    form:   'app/(dashboard)/properties/[id]/setup/details/details-form.tsx',
  },
]

// Fields a form legitimately never renders: hidden ids the caller injects, or
// values posted by a different form that shares the action. Shrink-only —
// adding an entry means "this action reads a field no form provides", which is
// the very bug above unless there is a real reason.
const EXCEPTIONS = new Set<string>([])

/**
 * The body of one named function, by brace matching from its declaration.
 * Crude but sufficient here, and it fails loudly (throws) rather than
 * returning '' if the function is renamed away — a guardrail that silently
 * scans nothing is worse than no guardrail.
 */
function functionBody(src: string, name: string): string {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`).exec(src)
  if (!decl) throw new Error(`function ${name} not found — update PAIRS`)
  const open = src.indexOf('{', decl.index + decl[0].length)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces reading ${name}`)
}

function fieldsRead(src: string): string[] {
  return [...new Set([...src.matchAll(/formData\.get\('([^']+)'\)/g)].map((m) => m[1]))]
}
function fieldsRendered(src: string): Set<string> {
  return new Set([...src.matchAll(/name="([^"]+)"/g)].map((m) => m[1]))
}

describe('guardrail: every form field a Server Action reads is actually rendered', () => {
  for (const { action, fn, form, label } of PAIRS) {
    it(`${label} reads no field its form omits`, () => {
      const actionPath = join(ROOT, action)
      const formPath   = join(ROOT, form)
      // A moved or renamed file must fail loudly rather than vacuously pass.
      expect(existsSync(actionPath), `${action} not found`).toBe(true)
      expect(existsSync(formPath), `${form} not found`).toBe(true)

      const read     = fieldsRead(functionBody(readFileSync(actionPath, 'utf8'), fn))
      const rendered = fieldsRendered(readFileSync(formPath, 'utf8'))

      const missing = read
        .filter((f) => !rendered.has(f))
        .filter((f) => !EXCEPTIONS.has(`${label}:${f}`))

      expect(
        missing,
        `${label} reads ${missing.join(', ')} but ${form} renders no such input — ` +
          'the action will apply its own fallback and silently overwrite the stored value',
      ).toEqual([])
    })
  }

  it('the exception list only names fields that are genuinely still unrendered', () => {
    // Shrink-only: once a form starts rendering an excepted field, the entry
    // has to go, or it hides a future regression on that same field.
    const stale: string[] = []
    for (const { action, fn, form, label } of PAIRS) {
      const read     = fieldsRead(functionBody(readFileSync(join(ROOT, action), 'utf8'), fn))
      const rendered = fieldsRendered(readFileSync(join(ROOT, form), 'utf8'))
      for (const key of EXCEPTIONS) {
        const [owner, field] = key.split(':')
        if (owner !== label) continue
        if (rendered.has(field) || !read.includes(field)) stale.push(key)
      }
    }
    expect(stale, `Remove these from EXCEPTIONS — they no longer apply: ${stale.join(', ')}`).toEqual([])
  })
})
