import { describe, it, expect } from 'vitest'
import { patternMatchLength, robotsAllows } from '@/lib/gtm/teams/robots'

const UA = 'FieldStayResearchBot/0.1 (+https://fieldstay.app)'

describe('robotsAllows', () => {
  it('allows everything when there is no file, an empty file, or no applicable group', () => {
    expect(robotsAllows('', '/contact', UA)).toBe(true)
    expect(robotsAllows('# nothing here', '/contact', UA)).toBe(true)
    expect(robotsAllows('User-agent: googlebot\nDisallow: /', '/contact', UA)).toBe(true)
  })

  it('obeys a blanket disallow for everyone', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /', '/', UA)).toBe(false)
    expect(robotsAllows('User-agent: *\nDisallow: /', '/contact', UA)).toBe(false)
  })

  it('treats an empty Disallow as allow-all', () => {
    expect(robotsAllows('User-agent: *\nDisallow:', '/contact', UA)).toBe(true)
  })

  it('applies a path rule only to that path', () => {
    const txt = 'User-agent: *\nDisallow: /admin'
    expect(robotsAllows(txt, '/admin/users', UA)).toBe(false)
    expect(robotsAllows(txt, '/contact', UA)).toBe(true)
  })

  it('lets the most specific group win over *', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: fieldstayresearchbot\nDisallow:'
    expect(robotsAllows(txt, '/contact', UA)).toBe(true)
    // ...and the same file shuts out an agent that is only covered by the wildcard.
    expect(robotsAllows(txt, '/contact', 'SomeOtherBot/1.0')).toBe(false)
  })

  it('lets the longest matching rule win, and Allow win a tie', () => {
    const txt = 'User-agent: *\nDisallow: /private\nAllow: /private/press'
    expect(robotsAllows(txt, '/private/press/kit', UA)).toBe(true)
    expect(robotsAllows(txt, '/private/other', UA)).toBe(false)
    expect(robotsAllows('User-agent: *\nDisallow: /x\nAllow: /x', '/x', UA)).toBe(true)
  })

  it('treats consecutive User-agent lines as one group', () => {
    const txt = 'User-agent: a\nUser-agent: fieldstayresearchbot\nDisallow: /nope'
    expect(robotsAllows(txt, '/nope', UA)).toBe(false)
  })

  it('ignores comments, case and CRLF line endings', () => {
    const txt = 'USER-AGENT: *   # everyone\r\nDISALLOW: /secret # keep out\r\n'
    expect(robotsAllows(txt, '/secret', UA)).toBe(false)
    expect(robotsAllows(txt, '/public', UA)).toBe(true)
  })

  it('does not let a rule line before any User-agent apply to anyone', () => {
    expect(robotsAllows('Disallow: /\nUser-agent: *\nAllow: /', '/x', UA)).toBe(true)
  })
})

describe('patternMatchLength', () => {
  it.each([
    ['/admin', '/admin/x', 6],
    ['/admin', '/other', -1],
    ['/*.pdf$', '/docs/a.pdf', 6],
    ['/*.pdf$', '/docs/a.pdf?x=1', -1],
    ['/a*b*c', '/a1b2c3', 6],
    ['/a*b*c', '/a1c2b', -1],
    ['/exact$', '/exact', 6],
    ['/exact$', '/exact/more', -1],
    ['*', '/anything', 1],
    ['', '/x', -1],
  ])('%s against %s gives %i', (pattern, path, expected) => {
    expect(patternMatchLength(pattern, path)).toBe(expected)
  })

  // The file is a stranger's. A regex built from this would backtrack for minutes.
  it('stays fast on a pattern built to make a regex backtrack', () => {
    const pattern = `/${'*a'.repeat(40)}*b`
    const path = `/${'a'.repeat(5_000)}`
    const started = Date.now()
    expect(patternMatchLength(pattern, path)).toBe(-1)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('caps how much of a huge file it will read', () => {
    const big = `User-agent: *\n${'Disallow: /x\n'.repeat(50_000)}Disallow: /late`
    expect(robotsAllows(big, '/late', UA)).toBe(true)
  })
})
