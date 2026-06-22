'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { getDexieDb, type FieldStayDexie } from './schema'
import { getSyncEngine } from './syncService'

const DexieDbContext = createContext<FieldStayDexie | null>(null)

/**
 * Mirrors PowerSyncContext.Provider in app/crew/crew-shell.tsx: resolves the
 * active user's session the same way SupabaseConnector.fetchCredentials()
 * does in lib/powersync/client.ts (gracefully returning null rather than
 * throwing when there's no session yet), then hands the per-user Dexie
 * instance down through context.
 */
export function DexieProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()

    async function resolveSession() {
      const { data: { session } } = await supabase.auth.getSession()
      setUserId(session?.user.id ?? null)
    }

    resolveSession()

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        setUserId(session?.user.id ?? null)
      }
    )

    return () => subscription.subscription.unsubscribe()
  }, [])

  // Flush the outbox whenever the device comes back online — mirrors
  // crew-shell.tsx's 'online' listener for processPendingPhotoUploads.
  useEffect(() => {
    if (!userId) return

    const flush = () => { void getSyncEngine(userId).processOutbox() }
    flush() // attempt once on mount, in case mutations were queued in a prior session
    window.addEventListener('online', flush)
    return () => window.removeEventListener('online', flush)
  }, [userId])

  const db = userId ? getDexieDb(userId) : null

  return (
    <DexieDbContext.Provider value={db}>
      {children}
    </DexieDbContext.Provider>
  )
}

/** Mirrors usePowerSync() from @powersync/react. */
export function useDexieDb(): FieldStayDexie {
  const db = useContext(DexieDbContext)
  if (!db) {
    throw new Error('useDexieDb must be used within a DexieProvider, with an active session')
  }
  return db
}
