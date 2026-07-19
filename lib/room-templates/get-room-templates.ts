import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface RoomTemplateWithItems {
  id:          string
  name:        string
  autoInclude: boolean
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
    .select(`id, name, auto_include, room_template_items ( id, task, requires_photo, notes, sort_order )`)
    .eq('org_id', orgId)
    .order('name')

  if (error) {
    console.error('[getRoomTemplatesForOrg]', error)
    return []
  }

  return (rooms ?? []).map((room) => ({
    id:          room.id as string,
    name:        room.name as string,
    autoInclude: room.auto_include as boolean,
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
