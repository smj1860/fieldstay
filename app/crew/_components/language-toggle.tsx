'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useCrewContext } from '@/lib/crew/crew-context'
import { useCrewT } from '@/lib/crew/i18n'
import { setCrewLocale } from '@/app/crew/settings/actions'
import type { CrewLocale } from '@/types/database'

/**
 * Compact EN/ES segmented control for the crew dashboard header. Moved off
 * the Help/FAQ panel (where it was easy to miss on first login) onto the
 * main crew page so a crew member can switch language before they ever need
 * to open Help.
 */
export function LanguageToggle() {
  const { crewLocale } = useCrewContext()
  const t = useCrewT()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const choose = (next: CrewLocale) => {
    if (next === crewLocale || isPending) return
    setError(null)
    startTransition(async () => {
      const result = await setCrewLocale(next)
      if (result.error) { setError(result.error); return }
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col items-end">
      <div
        className="inline-flex rounded-full p-0.5"
        style={{ background: 'rgba(13, 31, 60, 0.12)' }}
        role="group"
        aria-label={t('language')}
      >
        <button
          type="button"
          disabled={isPending}
          aria-pressed={crewLocale === 'en'}
          onClick={() => choose('en')}
          className="px-2.5 py-1 rounded-full text-[11px] font-bold transition-colors"
          style={{
            background: crewLocale === 'en' ? '#0D1F3C' : 'transparent',
            color:      crewLocale === 'en' ? '#fff' : '#0D1F3C',
          }}
        >
          {t('languageEn')}
        </button>
        <button
          type="button"
          disabled={isPending}
          aria-pressed={crewLocale === 'es'}
          onClick={() => choose('es')}
          className="px-2.5 py-1 rounded-full text-[11px] font-bold transition-colors"
          style={{
            background: crewLocale === 'es' ? '#0D1F3C' : 'transparent',
            color:      crewLocale === 'es' ? '#fff' : '#0D1F3C',
          }}
        >
          {t('languageEs')}
        </button>
      </div>
      {error && (
        <p className="text-[11px] mt-1" style={{ color: 'var(--accent-red)' }} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
