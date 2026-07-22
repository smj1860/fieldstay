import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface RoomTemplateWithItems {
  id:          string
  name:        string
  autoInclude: boolean
  isSystem:    boolean
  items: Array<{ id: string; task: string; requires_photo: boolean; notes: string }>
}

/**
 * Shared org room-template fetch + reshape (nested join -> RoomLibraryBuilder's
 * exact camelCase prop shape). Used by both the Settings page and the
 * onboarding checklist-template step so the reshape logic can't silently
 * drift apart between the two call sites.
 */
export async function getRoomTemplatesForOrg(
  supabase: SupabaseClient,
  orgId:    string,
): Promise<RoomTemplateWithItems[]> {
  const { data: rooms, error } = await supabase
    .from('room_templates')
    .select(`id, name, auto_include, is_system, room_template_items ( id, task, requires_photo, notes, sort_order )`)
    .eq('org_id', orgId)
    .order('name')

  if (error) {
    console.error('[getRoomTemplatesForOrg]', error)
    // Thrown, not swallowed into an empty array — both call sites render
    // this straight into an "everything's fine, just no rooms" empty
    // state (RoomLibraryBuilder), which would hide a real query failure
    // behind what looks like normal empty data. Caught by the
    // (dashboard) route group's error.tsx boundary.
    throw new Error('Failed to load room templates')
  }

  return (rooms ?? []).map((room) => ({
    id:          room.id as string,
    name:        room.name as string,
    autoInclude: room.auto_include as boolean,
    isSystem:    room.is_system as boolean,
    items: [...(room.room_template_items ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({
        id:             item.id as string,
        task:           item.task as string,
        requires_photo: item.requires_photo as boolean,
        notes:          (item.notes as string | null) ?? '',
      })),
  }))
}
