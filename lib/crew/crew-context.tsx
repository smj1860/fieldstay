'use client'

import { createContext, useContext } from 'react'

interface CrewContextValue {
  crewName: string
  userId:   string
}

export const CrewContext = createContext<CrewContextValue | null>(null)

export function useCrewContext(): CrewContextValue {
  const ctx = useContext(CrewContext)
  if (!ctx) throw new Error('useCrewContext must be inside CrewShell')
  return ctx
}
