import { describe, it, expect } from 'vitest'
import { fileExtension } from '@/app/crew/_components/discovery-capture-modal'

// ============================================================================
// `name.split('.').pop() || 'jpg'` looks right but isn't: 'photo'.split('.')
// is ['photo'], and .pop() on that returns the truthy string 'photo' — so the
// `|| 'jpg'` fallback only ever fires on an EMPTY filename, never on one with
// no dot at all. Some capture pipelines (certain Android WebViews, some
// capture="environment" implementations, a File built from a blob with no
// conventional name) hand back exactly that — a name with no extension —
// which silently became a storage key like `smart_lock-<uuid>.photo`.
// ============================================================================

describe('fileExtension', () => {
  it('extracts a normal extension', () => {
    expect(fileExtension('photo.jpg')).toBe('jpg')
    expect(fileExtension('IMG_20260915.HEIC')).toBe('HEIC')
  })

  it('falls back to jpg for a filename with NO dot at all', () => {
    expect(fileExtension('photo')).toBe('jpg')
    expect(fileExtension('IMG20260915')).toBe('jpg')
  })

  it('falls back to jpg for an empty filename', () => {
    expect(fileExtension('')).toBe('jpg')
  })

  it('falls back to jpg for a dotfile with no extension after the dot', () => {
    // A leading dot at index 0 is a hidden-file convention, not an extension
    // separator — '.jpg' as a whole filename has nothing before the dot.
    expect(fileExtension('.jpg')).toBe('jpg')
  })

  it('falls back to jpg when the filename ends in a bare dot', () => {
    expect(fileExtension('photo.')).toBe('jpg')
  })

  it('handles multiple dots by taking the LAST segment', () => {
    expect(fileExtension('my.vacation.photo.png')).toBe('png')
  })
})
