'use client'
import { PowerSyncContext } from '@powersync/react'
import { usePowerSync } from '@powersync/react'
import { getPowerSyncDb } from '@/lib/powersync/client'

export function CrewShell({
  crewName,
  children,
}: {
  crewName: string
  children: React.ReactNode
}) {
  const db = getPowerSyncDb()

  return (
    <PowerSyncContext.Provider value={db}>
      <div className="min-h-screen bg-accent-50 flex flex-col max-w-lg mx-auto">
        <header className="bg-brand-800 text-white px-4 py-4 flex items-center justify-between sticky top-0 z-10">
          <div>
            <span className="font-bold text-lg">FieldStay Crew</span>
            <p className="text-brand-200 text-xs">{crewName}</p>
          </div>
          <SyncStatus />
        </header>
        <main className="flex-1 px-4 py-6">{children}</main>
      </div>
    </PowerSyncContext.Provider>
  )
}

function SyncStatus() {
  const db = usePowerSync()
  const connected = db?.currentStatus?.connected

  if (connected) return null
  return (
    <span className="bg-amber-400 text-amber-900 text-xs font-medium px-2 py-1 rounded-full">
      Offline
    </span>
  )
}
