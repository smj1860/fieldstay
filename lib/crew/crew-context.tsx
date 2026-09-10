'use client'

import { createContext, useContext } from 'react'
import type { CrewLocale } from '@/types/database'

interface CrewContextValue {
  crewName:   string
  userId:     string
  /**
   * Read fresh in app/crew/layout.tsx on every request, never cached in
   * Dexie — crew_members was deliberately dropped from that cache (see
   * lib/dexie/schema.ts version 4). /crew is one of the service worker's
   * offline-cached shell routes, so the server-rendered HTML (locale
   * already baked in from the last request made with a connection) is what
   * gets served back offline; this context just threads that same
   * request-scoped value down without a second fetch.
   */
  crewLocale: CrewLocale
}

export const CrewContext = createContext<CrewContextValue | null>(null)

export function useCrewContext(): CrewContextValue {
  const ctx = useContext(CrewContext)
  if (!ctx) throw new Error('useCrewContext must be inside CrewShell')
  return ctx
}
