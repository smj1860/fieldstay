import { useCrewContext } from './crew-context'
import type { CrewLocale } from '@/types/database'

/**
 * The crew app's UI-chrome dictionary — nav labels, buttons, static
 * messages. Deliberately a plain object rather than a library like
 * next-intl: the crew app is a closed set of ~27 files, and this codebase
 * favors minimal dependencies (see CLAUDE.md's "Never introduce" list).
 *
 * Keys are added here as each screen is wired up (see the tasks tracked
 * alongside this file's introduction) — this starts with just the language
 * toggle itself.
 */
const CREW_DICT = {
  en: {
    language:      'Language',
    languageEn:    'English',
    languageEs:    'Español',
    languageSaved: 'Saved',
  },
  es: {
    language:      'Idioma',
    languageEn:    'English',
    languageEs:    'Español',
    languageSaved: 'Guardado',
  },
} as const satisfies Record<CrewLocale, Record<string, string>>

export type CrewDictKey = keyof (typeof CREW_DICT)['en']

/** Pure lookup — no fallback needed since both locales carry every key (enforced by the `satisfies` above). */
export function translateCrew(locale: CrewLocale, key: CrewDictKey): string {
  return CREW_DICT[locale][key]
}

export function useCrewT(): (key: CrewDictKey) => string {
  const { crewLocale } = useCrewContext()
  return (key) => translateCrew(crewLocale, key)
}
