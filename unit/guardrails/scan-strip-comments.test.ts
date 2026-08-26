import { describe, it, expect } from 'vitest'
import { blankComments, blankNonCode, stripComments } from './scan'

// ============================================================================
// THE COMMENT STRIPPER, which three guardrails now depend on.
//
// It is load-bearing in both directions and each has a way to fail silently:
//
//  - Strip too LITTLE and the guardrails go back to reading prose, which is the
//    whole class this was written to close.
//  - Strip too MUCH and it deletes real code — `'https://x'` and `/\/\*/` both
//    contain a comment opener — which manufactures findings indistinguishable
//    from genuine ones and would send someone "fixing" working code.
//
// Line numbers matter as much as content: every scanner that uses this reports
// `file:line` keys into an EXCEPTIONS allowlist, so a stripper that shifts
// lines silently invalidates every entry in every one of those lists.
// ============================================================================

describe('stripComments — removes comments', () => {
  it('removes a line comment but keeps the newline', () => {
    expect(stripComments('const a = 1 // note\nconst b = 2')).toBe('const a = 1 \nconst b = 2')
  })

  it('removes a block comment', () => {
    expect(stripComments('const a = /* note */ 1')).toBe('const a =  1')
  })

  it('removes JSDoc, keeping the line count', () => {
    const src = '/**\n * note\n */\nconst a = 1'
    const out = stripComments(src)
    expect(out).not.toContain('note')
    expect(out.split('\n')).toHaveLength(src.split('\n').length)
  })

  it('does not leave comment text able to satisfy a scanner', () => {
    // The exact shape that broke commercial-email-optout: the required phrase
    // present only in prose.
    const src = '/** FAILS CLOSED when the read errors. */\nreturn { suppressed: false }'
    expect(stripComments(src)).not.toContain('FAILS CLOSED')
  })

  it('frees the character budget a windowed scanner measures', () => {
    // The shape that broke sensitive-data-logging: a comment inside a call
    // pushing the real argument past a fixed-size window. A stripper that
    // replaced comments with equivalent blanks would preserve positions and
    // leave this defect exactly where it was.
    const src = 'logAuditEvent({\n  // a fairly long explanatory comment sitting inside the call\n  amount: x,\n})'
    expect(stripComments(src).length).toBeLessThan(src.length - 50)
  })
})

describe('stripComments — never damages real code', () => {
  // Every row here is a construct that CONTAINS something a naive stripper
  // reads as a comment opener, and must survive untouched. Tabled rather than
  // written out: the assertion is identical in each and the hazard is the only
  // thing that varies, so the label carries the reasoning.
  it.each([
    // A line-comment regex over raw source deletes the rest of this line.
    ['a URL inside a string',            "const u = 'https://api.mapbox.com/geocoding/v5'"],
    ['a block-comment opener in a string', 'const s = "/* not a comment */"'],
    ['a line-comment opener in a string',  "const s = '// not a comment'"],
    // Escaped slashes and stars — the shape this module's own docs describe.
    ['a regex literal full of slashes',  'const re = /\\/\\*|\\/\\//g'],
    ['a template literal interpolation', 'const s = `a ${b ? "x" : "y"} c`'],
    ['a template literal with a URL and braces', 'const s = `https://x/${id}/report`'],
    // `<` is excluded from the regex-predecessor set precisely for this: with
    // it in, `</div>` opens a "regex" that swallows to the next slash.
    ['a JSX closing tag',                '<div>{a}</div><span>{b}</span>'],
  ])('leaves %s untouched', (_hazard, src) => {
    expect(stripComments(src)).toBe(src)
  })

  it('treats division as division, not as a regex opener', () => {
    const src = 'const r = width / 5\nconst q = total / count // done'
    expect(stripComments(src)).toBe('const r = width / 5\nconst q = total / count ')
  })

  it('keeps an escaped quote from ending a string early', () => {
    const src = "const s = 'it\\'s fine' // gone"
    expect(stripComments(src)).toBe("const s = 'it\\'s fine' ")
  })
})

describe('stripComments — line numbers survive', () => {
  it('preserves the line index of every statement', () => {
    const src = [
      'const a = 1',              // 1
      '// a comment',             // 2
      '/* block',                 // 3
      '   spanning */',           // 4
      'const b = 2',              // 5
      '/** jsdoc',                // 6
      ' * more',                  // 7
      ' */',                      // 8
      'const c = 3',              // 9
    ].join('\n')

    const out   = stripComments(src)
    const lines = out.split('\n')
    expect(lines).toHaveLength(9)
    expect(lines[0]).toContain('const a = 1')
    expect(lines[4]).toContain('const b = 2')
    expect(lines[8]).toContain('const c = 3')
  })
})

// ============================================================================
// THE OFFSET-PRESERVING MODES.
//
// stripComments is wrong for a scanner that walks the source by INDEX — it
// shifts every offset left, so a position taken from the stripped text no
// longer addresses the same character in the file. blankComments and
// blankNonCode blank in place instead, and the property both of them sell is
// that `output.length === input.length`. That is asserted on every case below,
// because a scanner built on a mode that quietly dropped a character would
// report line numbers that drift further out the further down the file it got.
// ============================================================================

const CHAIN = "supabase.from('bookings')/* why */.select('id').limit(10)"

describe('blankComments — comments blanked, literals readable', () => {
  it('is the same length as its input', () => {
    expect(blankComments(CHAIN)).toHaveLength(CHAIN.length)
  })

  it('erases a block comment mid-chain without breaking the chain', () => {
    const out = blankComments(CHAIN)
    expect(out).not.toContain('why')
    // The whole point for unbounded-select: with the comment gone, `.select(`
    // and `.limit(` are separated by nothing but whitespace, so a chain walk
    // reaches both. The hand-rolled scanner stopped dead at the comment and so
    // saw neither — under-reporting an unbounded read in one arrangement and
    // over-reporting a bounded one in the other.
    expect(out).toContain('.select(')
    expect(out).toContain('.limit(')
    expect(out.indexOf('.limit(')).toBe(CHAIN.indexOf('.limit('))
  })

  it('leaves literal CONTENT intact — the table name is read out of one', () => {
    // blankNonCode would blank 'bookings' to spaces, and the `.from('table')`
    // matcher requires [a-z_]+ between the quotes. Using the wrong mode here
    // does not throw; it silently matches nothing and the guardrail passes
    // while checking no file at all.
    expect(blankComments(CHAIN)).toContain("'bookings'")
    expect(/\.from\(\s*['"][a-z_]+['"]\s*\)/.test(blankComments(CHAIN))).toBe(true)
    expect(/\.from\(\s*['"][a-z_]+['"]\s*\)/.test(blankNonCode(CHAIN))).toBe(false)
  })
})

describe('blankNonCode — comments and literal bodies blanked', () => {
  it('is the same length as its input', () => {
    expect(blankNonCode(CHAIN)).toHaveLength(CHAIN.length)
  })

  it('blanks a literal body but keeps its delimiters', () => {
    const out = blankNonCode("const s = 'step.run('")
    expect(out).toHaveLength(21)
    expect(out).not.toContain('step.run')
    expect(out).toBe("const s = '         '")
  })

  it('does not let a regex literal swallow the rest of the file', () => {
    // THE BUG THIS MODE WAS EXTRACTED TO FIX. The previous local copy in
    // inngest-nested-steps had no notion of a regex literal, so the `"` inside
    // this character class opened a "string" that ran to the next quote —
    // erasing every line after it. In lib/utils/html.ts that was two thirds of
    // the file; any violation living past such a regex was unreachable.
    const src = 'const esc = /[&<>"]/g\nawait step.run("x", async () => {})'
    const out = blankNonCode(src)
    expect(out).toHaveLength(src.length)
    expect(out).toContain('step.run(')
    expect(out.split('\n')).toHaveLength(2)
  })

  it('blanks a regex body too, so a pattern cannot pose as a call', () => {
    const out = blankNonCode('const re = /step\\.run\\(/')
    expect(out).not.toContain('step')
    expect(out.startsWith('const re = /')).toBe(true)
  })

  it('keeps line numbers exact across a multi-line template', () => {
    const src = 'const a = 1\nconst t = `line\nspans\nthree`\nconst b = 2'
    const out = blankNonCode(src)
    expect(out).toHaveLength(src.length)
    expect(out.split('\n')).toHaveLength(5)
    expect(out.split('\n')[4]).toBe('const b = 2')
  })
})
