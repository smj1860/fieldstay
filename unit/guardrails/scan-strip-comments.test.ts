import { describe, it, expect } from 'vitest'
import { stripComments } from './scan'

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
    expect(out.split('\n').length).toBe(src.split('\n').length)
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
  it('leaves a URL in a string alone', () => {
    // `replace(/\/\/.*$/gm, '')` deletes the rest of this line.
    const src = "const u = 'https://api.mapbox.com/geocoding/v5'"
    expect(stripComments(src)).toBe(src)
  })

  it('leaves a comment opener inside a string alone', () => {
    expect(stripComments('const s = "/* not a comment */"')).toBe('const s = "/* not a comment */"')
    expect(stripComments("const s = '// not a comment'")).toBe("const s = '// not a comment'")
  })

  it('leaves a regex literal containing slashes alone', () => {
    const src = 'const re = /\\/\\*|\\/\\//g'
    expect(stripComments(src)).toBe(src)
  })

  it('handles a template literal with an interpolation', () => {
    const src = 'const s = `a ${b ? "x" : "y"} c`'
    expect(stripComments(src)).toBe(src)
  })

  it('handles a template literal containing a URL and braces', () => {
    const src = 'const s = `https://x/${id}/report`'
    expect(stripComments(src)).toBe(src)
  })

  it('treats division as division, not as a regex opener', () => {
    const src = 'const r = width / 5\nconst q = total / count // done'
    expect(stripComments(src)).toBe('const r = width / 5\nconst q = total / count ')
  })

  it('does not mis-scan a JSX closing tag as a regex', () => {
    // `<` is deliberately excluded from the regex-predecessor set: with it in,
    // `</div>` opens a "regex" that swallows to the next slash.
    const src = '<div>{a}</div><span>{b}</span>'
    expect(stripComments(src)).toBe(src)
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
    expect(lines.length).toBe(9)
    expect(lines[0]).toContain('const a = 1')
    expect(lines[4]).toContain('const b = 2')
    expect(lines[8]).toContain('const c = 3')
  })
})
