import { describe, it, expect } from 'vitest'
import { escapeHtml } from '@/lib/utils/html'

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry')
  })

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes double quotes', () => {
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;')
  })

  it('escapes single quotes', () => {
    expect(escapeHtml("it's here")).toBe('it&#39;s here')
  })

  it('escapes every special character together, in order', () => {
    expect(escapeHtml(`<a href="x">it's & "that"</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; &quot;that&quot;&lt;/a&gt;',
    )
  })

  it('leaves a string with no special characters unchanged', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123')
  })

  it('returns an empty string unchanged', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('does not double-escape an already-escaped ampersand sequence', () => {
    // Ensures the replacer only escapes the raw characters present, not
    // something that resembles an entity — "&amp;" in becomes "&amp;amp;" out.
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })

  it('handles a mix of raw text and repeated special characters', () => {
    expect(escapeHtml('a<b<c')).toBe('a&lt;b&lt;c')
  })
})
