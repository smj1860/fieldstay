'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import {
  getDexieDb,
  type FieldStayDexie,
  type TurnoverRow,
  type PropertyRow,
  type ChecklistInstanceRow,
  type ChecklistInstanceItemRow,
  type InventoryItemRow,
  type MessageRow,
} from './schema'
import { getSyncEngine } from './syncService'

interface DexieContextValue {
  db:     FieldStayDexie | null
  userId: string | null
}

const DexieContext = createContext<DexieContextValue>({ db: null, userId: null })

/**
 * Mirrors PowerSyncContext.Provider in app/crew/crew-shell.tsx: resolves the
 * active user's session the same way SupabaseConnector.fetchCredentials()
 * does in lib/powersync/client.ts (gracefully returning null rather than
 * throwing when there's no session yet), then hands the per-user Dexie
 * instance down through context.
 *
 * If the caller already knows the user id (e.g. a server-rendered layout
 * that called `auth.getUser()` and passed it down as a prop, as
 * app/crew/layout.tsx does), pass it as `userId` to make it available
 * synchronously on first render — otherwise descendants briefly see no db
 * while the client-side session resolves asynchronously.
 */
export function DexieProvider({ userId: userIdProp, children }: { userId?: string; children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(userIdProp ?? null)

  useEffect(() => {
    if (userIdProp) {
      setUserId(userIdProp)
      return
    }

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

  // Populate Dexie from Supabase — bootstraps the full cache on first run for
  // this user, then stays current via a `turnover_assignments` watermark
  // (lib/dexie/schema.ts SyncMetaRow) plus a Realtime subscription, instead
  // of the old "re-sync only if the cache is empty" check, which silently
  // stopped picking up new assignments made after a crew member's first
  // session (assignment lives in Supabase + RLS-correct, just never pulled
  // into IndexedDB).
  useEffect(() => {
    if (!userId) return

    const supabase = createClient()
    let cancelled = false

    async function syncAssignedTurnovers(crewMemberId: string): Promise<void> {
      const db = getDexieDb(userId!)
      const watermark = await db.sync_meta.get('turnover_assignments_synced_at')
      const since = watermark?.value ?? null
      const syncStartedAt = new Date().toISOString()

      let query = supabase
        .from('turnover_assignments')
        .select('turnover_id, created_at')
        .eq('crew_member_id', crewMemberId)
      if (since) query = query.gt('created_at', since)
      const { data: assignments, error } = await query
      if (error) {
        console.error('[DexieProvider] turnover_assignments sync failed:', error)
        return
      }

      const turnoverIds = [...new Set((assignments ?? []).map((a: { turnover_id: string }) => a.turnover_id))]
      if (!turnoverIds.length) {
        await db.sync_meta.put({ key: 'turnover_assignments_synced_at', value: syncStartedAt })
        return
      }

      const { data: turnovers } = await supabase
        .from('turnovers')
        .select('id, property_id, org_id, checkout_datetime, checkin_datetime, window_minutes, status, priority, notes')
        .in('id', turnoverIds)
      if (turnovers?.length) await db.turnovers.bulkPut(turnovers as TurnoverRow[])

      const propertyIds = [...new Set((turnovers ?? []).map((t: { property_id: string }) => t.property_id))]
      if (propertyIds.length) {
        const { data: properties } = await supabase
          .from('properties')
          .select('id, org_id, name, address, city, state, lat, lng')
          .in('id', propertyIds)
        if (properties?.length) await db.properties.bulkPut(properties as PropertyRow[])

        const { data: inventory } = await supabase
          .from('inventory_items')
          .select('id, property_id, org_id, name, category, unit, par_level, current_quantity')
          .in('property_id', propertyIds)
          .eq('is_active', true)
        if (inventory?.length) await db.inventory_items.bulkPut(inventory as InventoryItemRow[])
      }

      const { data: instances } = await supabase
        .from('checklist_instances')
        .select('id, turnover_id, org_id, status, section_photo_path')
        .in('turnover_id', turnoverIds)
      if (instances?.length) await db.checklist_instances.bulkPut(instances as ChecklistInstanceRow[])

      if (instances?.length) {
        const instanceIds = instances.map((i: { id: string }) => i.id)
        const { data: items } = await supabase
          .from('checklist_instance_items')
          .select('id, instance_id, turnover_id, section_name, task, is_completed, completed_at, completed_by_crew_id, requires_photo, photo_reason, photo_storage_path, crew_notes, sort_order, is_section_final_item')
          .in('instance_id', instanceIds)
        if (items?.length) {
          const normalized = items.map((item: Record<string, unknown>) => ({
            ...item,
            is_completed:          Number(item.is_completed ?? 0),
            requires_photo:        Number(item.requires_photo ?? 0),
            is_section_final_item: item.is_section_final_item != null ? Number(item.is_section_final_item) : 0,
            completed_by_crew_id:  item.completed_by_crew_id ?? '',
            crew_notes:            item.crew_notes ?? '',
            photo_reason:          item.photo_reason ?? '',
          }))
          await db.checklist_instance_items.bulkPut(normalized as ChecklistInstanceItemRow[])
        }
      }

      await db.sync_meta.put({ key: 'turnover_assignments_synced_at', value: syncStartedAt })
    }

    async function syncMessages(): Promise<void> {
      const db = getDexieDb(userId!)
      const { data: messages } = await supabase
        .from('messages')
        .select('id, org_id, sender_id, recipient_id, content, read_at, turnover_id, group_id, group_label, created_at')
        .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
        .order('created_at', { ascending: true })
      if (messages?.length) await db.messages.bulkPut(messages as MessageRow[])
    }

    let channel: ReturnType<typeof supabase.channel> | null = null

    async function run() {
      const { data: crewMember } = await supabase
        .from('crew_members')
        .select('id, org_id')
        .eq('user_id', userId!)
        .eq('is_active', true)
        .maybeSingle()
      if (!crewMember || cancelled) return

      // messages have no incremental watermark of their own yet — cheap
      // enough to re-pull in full each load.
      await Promise.all([syncAssignedTurnovers(crewMember.id), syncMessages()])
      if (cancelled) return

      // Catches reassignments that happen while the crew member is online,
      // rather than waiting for their next app open to pick them up.
      channel = supabase
        .channel(`turnover-assignments-${crewMember.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'turnover_assignments', filter: `crew_member_id=eq.${crewMember.id}` },
          () => { void syncAssignedTurnovers(crewMember.id) }
        )
        .subscribe()
    }

    run().catch((err) => console.error('[DexieProvider] sync failed:', err))

    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel)
    }
  }, [userId])

  const db = userId ? getDexieDb(userId) : null

  return (
    <DexieContext.Provider value={{ db, userId }}>
      {children}
    </DexieContext.Provider>
  )
}

/** Mirrors usePowerSync() from @powersync/react. */
export function useDexieDb(): FieldStayDexie {
  const { db } = useContext(DexieContext)
  if (!db) {
    throw new Error('useDexieDb must be used within a DexieProvider, with an active session')
  }
  return db
}

/** The authenticated user's id, as resolved by the nearest DexieProvider. */
export function useDexieUserId(): string {
  const { userId } = useContext(DexieContext)
  if (!userId) {
    throw new Error('useDexieUserId must be used within a DexieProvider, with an active session')
  }
  return userId
}
