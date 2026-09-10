import { describe, it, expect } from 'vitest'
import { translateCrew } from '@/lib/crew/i18n'

describe('translateCrew', () => {
  it('returns the English string for locale en', () => {
    expect(translateCrew('en', 'language')).toBe('Language')
  })

  it('returns the Spanish string for locale es', () => {
    expect(translateCrew('es', 'language')).toBe('Idioma')
  })

  it('never returns the same string for both locales on a translated key', () => {
    expect(translateCrew('en', 'language')).not.toBe(translateCrew('es', 'language'))
  })
})
